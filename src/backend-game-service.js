import { randomUUID } from 'node:crypto';
import { normalizePublicKey } from './create-game.js';
import { NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameId } from './protocol.js';
import { noopMetrics } from './metrics.js';
import { DEFAULT_WRPC_URL } from './wrpc.mjs';
import { logger } from './logger.js';

const MATCH_STAKE_KAS = 1;

// The server is only an opponent-discovery service. It pairs two players for a
// rival game and relays the creator's non-secret creation state to the joiner.
// The game itself (create/join/reveal/refund) is built, signed, and broadcast
// entirely in the browser, so the server never sees a reveal secret and is not
// needed once the two players have found each other.
export class BackendGameService {
  constructor({ store, metrics = noopMetrics }) {
    this.store = store;
    this.metrics = metrics;
  }

  // Static config only: deliberately does not touch the node, so booting the
  // client never blocks on a wRPC round-trip.
  networkStatus() {
    return {
      network: NETWORK,
      protocolVersion: PROTOCOL_VERSION,
      // Browser-usable wRPC endpoint. Distinct from any operator node URL so a
      // private/internal node URL never leaks to clients.
      wrpcUrl: process.env.KASPA_WRPC_BROWSER_URL ?? DEFAULT_WRPC_URL,
    };
  }

  // Wallet addresses are identity-sensitive and redacted by default. When
  // LOG_WALLET_ADDRESSES=1 the logger reveals them; this helper keeps call sites
  // silent (no `<redacted>` noise) unless an operator explicitly opted in.
  #logPlayer(event, address, fields = {}) {
    if (process.env.LOG_WALLET_ADDRESSES !== '1') return;
    logger.info(event, { address, ...fields });
  }

  async joinMatchmaking(input) {
    const address = this.#matchmakingAddress(input.address);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const match = await this.store.joinMatchmaking({ matchId: randomUUID(), address, publicKey });
    this.#logPlayer('matchmaking_join', address, { matchId: match.matchId, status: match.status });
    if (match.status === 'matched' && match.players.length === 2) {
      this.#logPlayer('matchmaking_paired', match.players[0].address, { matchId: match.matchId, opponentAddress: match.players[1].address });
    }
    this.metrics.recordGameEvent('matchmaking_join');
    await this.#recordMatchmakingBacklog();
    return this.#matchResponse(match, address);
  }

  async matchmakingStatus(matchId, address) {
    const match = await this.store.loadMatch(matchId);
    const playerAddress = this.#matchmakingAddress(address);
    this.#logPlayer('matchmaking_status', playerAddress, { matchId });
    this.#matchPlayer(match, playerAddress);
    await this.store.touchMatch(matchId, playerAddress);
    return this.#matchResponse(await this.store.loadMatch(matchId), playerAddress);
  }

  // The match creator publishes the on-chain creation here so the paired joiner
  // can rebuild the state-0 covenant and join. Only non-secret creation state is
  // relayed; the reveal choice never leaves the browser.
  async publishCreation(matchId, input) {
    const address = this.#matchmakingAddress(input.address);
    const match = await this.store.loadMatch(matchId);
    const player = this.#matchPlayer(match, address);
    if (match.status === 'waiting' || match.players.length !== 2) {
      throw new ProtocolError('MATCH_NOT_READY', 'Wait until a rival is found before starting the game');
    }
    if (match.players.indexOf(player) !== match.creatorIndex) {
      throw new ProtocolError('NOT_A_PLAYER', 'Only the match creator can publish the game');
    }
    const creation = this.#publishedCreation(input.creation);
    if (creation.creatorAddress !== address) {
      throw new ProtocolError('INVALID_GAME_STATE', 'The published game must belong to the match creator');
    }
    if (creation.side !== match.creatorSide) {
      throw new ProtocolError('INVALID_GAME_STATE', 'The published side must match the assigned side');
    }
    const updated = await this.store.updateMatch(matchId, (current) => {
      current.creation = creation;
      current.gameId = creation.gameId;
      current.status = 'started';
    });
    this.#logPlayer('matchmaking_creation', address, { matchId, gameId: creation.gameId });
    this.metrics.recordGameEvent('matchmaking_creation');
    return this.#matchResponse(updated, address);
  }

  #publishedCreation(creation) {
    if (!creation || typeof creation !== 'object') throw new ProtocolError('INVALID_GAME_STATE', 'A published creation is required');
    const side = creation.side === 'even' ? 'even' : creation.side === 'odd' ? 'odd' : null;
    if (!side) throw new ProtocolError('INVALID_GAME_STATE', 'Creator side must be even or odd');
    const stakeKas = Number(creation.stakeKas);
    if (!Number.isInteger(stakeKas) || stakeKas < 1) throw new ProtocolError('INVALID_GAME_STATE', 'Stake must be a positive whole number of KAS');
    let deadlineDaa;
    try {
      deadlineDaa = BigInt(creation.deadlineDaa);
    } catch {
      throw new ProtocolError('INVALID_GAME_STATE', 'Deadline DAA must be a positive integer');
    }
    if (deadlineDaa <= 0n) throw new ProtocolError('INVALID_GAME_STATE', 'Deadline DAA must be positive');
    return {
      gameId: validateGameId(creation.gameId),
      creatorPublicKey: normalizePublicKey(creation.creatorPublicKey, 'creator public key'),
      creatorCommitment: normalizeHex(creation.creatorCommitment, 32, 'creator commitment'),
      side,
      stakeKas,
      deadlineDaa: String(deadlineDaa),
      creatorAddress: this.#matchmakingAddress(creation.creatorAddress),
    };
  }

  async leaveMatchmaking(matchId, address) {
    const playerAddress = this.#matchmakingAddress(address);
    this.#logPlayer('matchmaking_leave', playerAddress, { matchId });
    const match = await this.store.loadMatch(matchId);
    this.#matchPlayer(match, playerAddress);
    await this.store.leaveMatch(matchId, playerAddress);
    this.metrics.recordGameEvent('matchmaking_leave');
    await this.#recordMatchmakingBacklog();
    return { matchId, status: 'left' };
  }

  #matchmakingAddress(value) {
    if (typeof value !== 'string' || !value.startsWith('kaspatest:')) throw new ProtocolError('INVALID_ADDRESS', 'Matchmaking requires a testnet wallet');
    return value;
  }

  async #recordMatchmakingBacklog() {
    try {
      this.metrics.setMatchmakingWaiting(await this.store.countWaitingMatches());
    } catch {
      // Backlog is best-effort telemetry; never let it affect a request.
    }
  }

  #matchPlayer(match, address) {
    if (!match || !Array.isArray(match.players)) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const index = match.players.findIndex((player) => player.address === address);
    if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
    return match.players[index];
  }

  #matchResponse(match, address) {
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const index = match.players.findIndex((player) => player.address === address);
    if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
    const isCreator = match.status !== 'waiting' && index === match.creatorIndex;
    const side = match.creatorSide === (isCreator ? 'even' : 'odd') ? 'even' : 'odd';
    return {
      matchId: match.matchId,
      status: match.status,
      role: match.status === 'waiting' ? null : isCreator ? 'creator' : 'joiner',
      side: match.status === 'waiting' ? null : side,
      gameId: match.gameId ?? null,
      creation: match.creation ?? null,
      stakeKas: MATCH_STAKE_KAS,
      opponentConnected: match.players.length === 2,
    };
  }
}

function normalizeHex(value, bytes, name) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}
