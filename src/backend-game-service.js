import { KaspaChainAdapter } from './chain-adapter.js';
import { randomUUID } from 'node:crypto';
import { normalizePublicKey, prepareCreateGame } from './create-game.js';
import { verifySignedCreationSafeJson } from './genesis-transaction.js';
import { deriveGameInstance } from './covenant/even-odd.mjs';
import { verifySignedJoinTransaction } from './join-transactions.js';
import { selectOrdinaryUtxos } from './fee-policy.js';
import { prepareRevealTransaction, prepareTerminalTransaction, serializeTerminalTransaction, verifySignedTerminalTransaction } from './terminal-transactions.js';
import { parityOutcome, verifyRevealPreimage } from './reveal.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { FALLBACK_CLAIM_DAA_OFFSET, FIVE_MINUTE_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET } from './terminal-actions.js';
import { NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameId } from './protocol.js';

const MATCH_STAKE_KAS = 1;

export class BackendGameService {
  constructor({ rpc, store }) {
    this.rpc = rpc;
    this.store = store;
  }

  async networkStatus() {
    const dag = await this.rpc.getBlockDagInfo();
    return { network: NETWORK, protocolVersion: PROTOCOL_VERSION, virtualDaaScore: String(dag.virtualDaaScore ?? dag.virtualDaaScoreString) };
  }

  async joinMatchmaking(input) {
    const address = this.#matchmakingAddress(input.address);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const match = await this.store.joinMatchmaking({ matchId: randomUUID(), address, publicKey });
    return this.#matchResponse(match, address);
  }

  async matchmakingStatus(matchId, address) {
    const match = await this.store.loadMatch(matchId);
    const playerAddress = this.#matchmakingAddress(address);
    this.#matchPlayer(match, playerAddress);
    await this.store.touchMatch(matchId, playerAddress);
    return this.#matchResponse(await this.store.loadMatch(matchId), playerAddress);
  }

  async submitMatchVote(matchId, input) {
    const address = this.#matchmakingAddress(input.address);
    const commitment = normalizeHex(input.commitment, 32, 'matchmaking commitment');
    const match = await this.store.loadMatch(matchId);
    const player = this.#matchPlayer(match, address);
    if (!['matched', 'ready', 'started'].includes(match.status) || match.players.length !== 2) {
      throw new ProtocolError('MATCH_NOT_READY', 'Wait until a rival is found before locking your vote');
    }
    if (player.commitment && player.commitment !== commitment) throw new ProtocolError('MATCH_VOTE_LOCKED', 'Your vote is already locked for this match');
    const updated = await this.store.updateMatch(matchId, (current) => {
      const participant = current.players.find((item) => item.address === address);
      participant.commitment = commitment;
      if (current.status !== 'started' && current.players.length === 2 && current.players.every((item) => item.commitment)) current.status = 'ready';
    });
    return this.#matchResponse(updated, address);
  }

  async leaveMatchmaking(matchId, address) {
    const playerAddress = this.#matchmakingAddress(address);
    const match = await this.store.loadMatch(matchId);
    this.#matchPlayer(match, playerAddress);
    await this.store.leaveMatch(matchId, playerAddress);
    return { matchId, status: 'left' };
  }

  async prepareCreation(input) {
    if (input.matchId) await this.#validateMatchCreation(input);
    const dag = await this.rpc.getBlockDagInfo();
    const request = prepareCreateGame({
      network: NETWORK,
      creatorAddress: input.creatorAddress,
      creatorPublicKey: input.creatorPublicKey,
      creatorCommitment: input.creatorCommitment,
      deadlineDaa: BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString) + FIVE_MINUTE_DAA_OFFSET,
      side: input.side,
      stakeKas: input.stakeKas,
      feeSompi: 0n,
    });
    const chain = this.#chain(request);
    const prepared = await chain.prepareCreation(request);
    const record = {
      preparedHash: prepared.preparedHash,
      request: serializeRequest(request),
      prepared: serializePrepared(prepared),
      createdAt: new Date().toISOString(),
      ...(input.matchId ? { matchId: input.matchId } : {}),
    };
    await this.store.savePrepared(record);
    return { network: NETWORK, preparedHash: prepared.preparedHash, txJson: prepared.txJson, feeSompi: String(prepared.feeSompi), deadlineDaa: String(request.deadlineDaa) };
  }

  async submitCreation({ preparedHash, signedTxJson, matchId }) {
    const record = await this.store.loadPrepared(preparedHash);
    if (!record) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Prepared transaction was not found or has expired');
    const request = deserializeRequest(record.request);
    const prepared = deserializePrepared(record.prepared);
    if (Boolean(record.matchId) !== Boolean(matchId) || (matchId && record.matchId !== matchId)) {
      throw new ProtocolError('MATCH_NOT_READY', 'This creation does not belong to the matchmaking session');
    }
    verifySignedCreationSafeJson({ preparedTxJson: prepared.txJson, signedTxJson, request, policy: prepared.policy });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    await this.store.saveGame({
      gameId: transactionId,
      network: NETWORK,
      protocolVersion: PROTOCOL_VERSION,
      status: 'broadcast',
      request: record.request,
      prepared: record.prepared,
      createdAt: new Date().toISOString(),
      ...(matchId ? { matchId } : {}),
    });
    if (matchId) await this.#attachMatchGame(matchId, request.creatorAddress, transactionId);
    return { gameId: transactionId, network: NETWORK, status: 'broadcast', inviteUrl: `/join?v=${encodeURIComponent(PROTOCOL_VERSION)}&game=${transactionId}` };
  }

  async prepareJoin(gameId, input) {
    const id = validateGameId(gameId);
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    if (gameRecord.matchId && input.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This game belongs to a different matchmaking session');
    if (gameRecord.matchId) await this.#validateMatchJoin(gameRecord.matchId, id, input.joinerAddress);
    const request = deserializeRequest(gameRecord.request);
    const creation = deserializePrepared(gameRecord.prepared);
    const joinerPublicKey = normalizePublicKey(input.joinerPublicKey, 'joiner public key');
    const joinerCommitment = normalizeHex(input.joinerCommitment, 32, 'joiner commitment');
    if (typeof input.joinerAddress !== 'string' || !input.joinerAddress.startsWith('kaspatest:')) {
      throw new ProtocolError('INVALID_ADDRESS', 'Player B must use a testnet address');
    }
    const { entry, currentDaaScore } = await this.#openCreationUtxo(id, request, creation);
    if (currentDaaScore >= request.deadlineDaa) throw new ProtocolError('GAME_EXPIRED', 'The joining deadline has passed');

    const joined = deriveGameInstance({
      creatorPubkey: request.creatorPublicKey,
      creatorCommit: request.creatorCommitment,
      joinerPubkey: joinerPublicKey,
      joinerCommit: joinerCommitment,
      potSompi: request.stakeSompi * 2n,
      deadlineDaa: request.deadlineDaa,
      creatorEven: request.creatorEven,
      status: 1,
    });
    const feeSompi = 4_200_000n;
    const chain = this.#chain(request);
    const prepared = await chain.prepareJoin({
      request: {
        network: NETWORK,
        gameId: id,
        joinerAddress: input.joinerAddress,
        joinerPublicKey,
        joinerCommitment,
        feeSompi,
      },
      game: {
        potSompi: request.stakeSompi,
        currentInput: {
          ...entry,
          transactionId: id,
          index: 0,
          covenantId: creation.covenantId,
        },
        currentCovenantId: creation.covenantId,
        currentRedeemScript: request.covenantRedeemScript,
        continuationScriptPublicKey: `0000${joined.p2shScript.toString('hex')}`,
        continuationCovenant: { authorizingInput: 0, covenantId: creation.covenantId },
      },
    });
    const record = {
      preparedHash: prepared.preparedHash,
      gameId: id,
      joinerAddress: input.joinerAddress,
      joinerPublicKey,
      joinerCommitment,
      txJson: prepared.txJson,
      feeSompi: String(prepared.feeSompi),
      joinedAddress: joined.address,
      joinedScriptPublicKey: `0000${joined.p2shScript.toString('hex')}`,
      joinedRedeemScript: joined.redeemScript.toString('hex'),
      covenantId: creation.covenantId,
      createdAt: new Date().toISOString(),
      ...(gameRecord.matchId ? { matchId: gameRecord.matchId } : {}),
    };
    await this.store.saveJoinPrepared(record);
    return { gameId: id, preparedHash: record.preparedHash, txJson: record.txJson, stakeSompi: String(request.stakeSompi), feeSompi: record.feeSompi };
  }

  async submitJoin(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadJoinPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Join preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    if (gameRecord.matchId && prepared.matchId !== gameRecord.matchId) throw new ProtocolError('MATCH_NOT_READY', 'This join does not belong to the matchmaking session');
    if (gameRecord.join?.transactionId) throw new ProtocolError('GAME_ALREADY_JOINED', 'Another player already joined this game');
    const request = deserializeRequest(gameRecord.request);
    const creation = deserializePrepared(gameRecord.prepared);
    await this.#openCreationUtxo(id, request, creation);
    verifySignedJoinTransaction({ preparedTxJson: prepared.txJson, signedTxJson });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    await this.store.saveGame({
      ...gameRecord,
      status: 'join_broadcast',
      join: {
        transactionId,
        preparedHash,
        joinerAddress: prepared.joinerAddress,
        joinerPublicKey: prepared.joinerPublicKey,
        joinerCommitment: prepared.joinerCommitment,
        joinedAddress: prepared.joinedAddress,
        joinedScriptPublicKey: prepared.joinedScriptPublicKey,
        joinedRedeemScript: prepared.joinedRedeemScript,
        covenantId: prepared.covenantId,
        submittedAt: new Date().toISOString(),
      },
    });
    return { gameId: id, transactionId, status: 'join_broadcast' };
  }

  async prepareReveal(gameId, input) {
    const id = validateGameId(gameId);
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    gameRecord = await this.#refreshActionState(gameRecord);
    if (gameRecord.status === 'settled') throw new ProtocolError('GAME_SETTLED', 'This game is already settled');
    const request = deserializeRequest(gameRecord.request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = this.#player(gameRecord, request, input.playerAddress, publicKey);
    const choice = Number(input.choice);
    const nonceHex = normalizeHex(input.nonceHex, 32, 'reveal nonce');
    if (!Number.isInteger(choice) || (choice !== 0 && choice !== 1)) throw new ProtocolError('INVALID_REVEAL', 'Choice must be zero or one');
    if (!verifyRevealPreimage({ commitment: player.commitment, choice, nonceHex })) throw new ProtocolError('INVALID_REVEAL', 'Reveal does not match the saved commitment');

    const confirmedReveals = (gameRecord.reveals ?? []).filter((reveal) => reveal.status === 'confirmed');
    if (confirmedReveals.some((reveal) => reveal.playerAddress === player.address)) throw new ProtocolError('ALREADY_REVEALED', 'This player already revealed');
    if ((gameRecord.reveals ?? []).some((reveal) => reveal.status !== 'confirmed')) throw new ProtocolError('ACTION_PENDING', 'The previous reveal is still confirming');
    const current = await this.#currentGameUtxo(gameRecord, request, confirmedReveals);
    const first = confirmedReveals[0];
    const feeSompi = 4_200_000n;
    const funding = await this.#actionFunding(player.address, feeSompi);
    const state = this.#revealGameState(id, gameRecord, request, current, confirmedReveals);

    let continuation;
    let winner;
    if (!first) {
      const firstHash = Buffer.from(blake2b256(Buffer.from(publicKey, 'hex'))).toString('hex');
      continuation = deriveGameInstance({
        creatorPubkey: request.creatorPublicKey,
        creatorCommit: request.creatorCommitment,
        joinerPubkey: gameRecord.join.joinerPublicKey,
        joinerCommit: gameRecord.join.joinerCommitment,
        potSompi: request.stakeSompi * 2n,
        deadlineDaa: request.deadlineDaa,
        creatorEven: request.creatorEven,
        creatorChoice: player.role === 'creator' ? choice : 0,
        joinerChoice: player.role === 'joiner' ? choice : 0,
        firstRevealerHash: firstHash,
        status: 2,
      });
    } else {
      const creatorChoice = player.role === 'creator' ? choice : first.choice;
      const joinerChoice = player.role === 'joiner' ? choice : first.choice;
      winner = parityOutcome({ creatorChoice, joinerChoice, creatorEven: request.creatorEven });
    }

    const prepared = prepareRevealTransaction({
      game: state,
      caller: player.address,
      currentDaaScore: current.currentDaaScore,
      secret: { gameId: id, player: player.address, choice, nonceHex },
      gameInput: { ...current.entry, transactionId: current.transactionId, index: 0, covenantId: gameRecord.join.covenantId, redeemScript: current.redeemScript },
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationCovenant: continuation ? { authorizingInput: 0, covenantId: gameRecord.join.covenantId } : undefined,
      recipientScriptPublicKey: winner ? playerScriptPublicKey(winner === 'creator' ? request.creatorPublicKey : gameRecord.join.joinerPublicKey) : undefined,
      feeInputs: funding.inputs,
      feeSompi,
      change: funding.change,
      publicKey,
      payoutPublicKey: winner === 'creator' ? request.creatorPublicKey : winner === 'joiner' ? gameRecord.join.joinerPublicKey : publicKey,
    });
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    const record = {
      preparedHash,
      action: 'reveal',
      gameId: id,
      playerAddress: player.address,
      role: player.role,
      choice,
      txJson,
      transaction: prepared.transaction,
      feeSompi: String(feeSompi),
      continuationAddress: continuation?.address,
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationRedeemScript: continuation?.redeemScript.toString('hex'),
      winner,
      payoutAddress: winner === 'creator' ? request.creatorAddress : winner ? gameRecord.join.joinerAddress : undefined,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveActionPrepared(record);
    return { gameId: id, preparedHash, txJson, feeSompi: String(feeSompi), stage: first ? 'settlement' : 'first_reveal' };
  }

  async submitReveal(gameId, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadActionPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== 'reveal') throw new ProtocolError('PREPARATION_NOT_FOUND', 'Reveal preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    if (!gameRecord?.join) throw new ProtocolError('GAME_NOT_JOINED', 'Player B has not joined this game');
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    const reveal = {
      transactionId,
      preparedHash,
      playerAddress: prepared.playerAddress,
      role: prepared.role,
      choice: prepared.choice,
      status: 'broadcast',
      continuationAddress: prepared.continuationAddress,
      continuationScriptPublicKey: prepared.continuationScriptPublicKey,
      continuationRedeemScript: prepared.continuationRedeemScript,
      winner: prepared.winner,
      payoutAddress: prepared.payoutAddress,
      submittedAt: new Date().toISOString(),
    };
    await this.store.saveGame({ ...gameRecord, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast', reveals: [...(gameRecord.reveals ?? []), reveal] });
    return { gameId: id, transactionId, status: prepared.winner ? 'settlement_broadcast' : 'reveal_broadcast' };
  }

  async prepareSafetyAction(gameId, action, input) {
    const id = validateGameId(gameId);
    let gameRecord = await this.store.loadGame(id);
    if (!gameRecord) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not found');
    gameRecord = await this.#refreshActionState(gameRecord);
    gameRecord = await this.#refreshSafetyState(gameRecord);
    if ((gameRecord.safetyActions ?? []).some((item) => item.status !== 'confirmed')) throw new ProtocolError('ACTION_PENDING', 'The previous recovery action is still confirming');
    const request = deserializeRequest(gameRecord.request);
    const publicKey = normalizePublicKey(input.playerPublicKey, 'player public key');
    const player = action === 'creator_refund' && !gameRecord.join
      ? this.#creator(request, input.playerAddress, publicKey)
      : this.#player(gameRecord, request, input.playerAddress, publicKey);
    const confirmedReveals = (gameRecord.reveals ?? []).filter((item) => item.status === 'confirmed');
    const confirmedRefunds = (gameRecord.safetyActions ?? []).filter((item) => item.action === 'refund_player' && item.status === 'confirmed');
    let current;
    let covenantEntry;
    let sequence = 0n;
    let continuation;
    let continuationOutputIndex;

    if (action === 'creator_refund') {
      if (gameRecord.join) throw new ProtocolError('ACTION_UNAVAILABLE', 'Player B already joined this game');
      const creation = deserializePrepared(gameRecord.prepared);
      const open = await this.#openCreationUtxo(id, request, creation);
      if (open.currentDaaScore < request.deadlineDaa) throw new ProtocolError('ACTION_UNAVAILABLE', 'The game is still open for Player B');
      current = { entry: open.entry, currentDaaScore: open.currentDaaScore, transactionId: id, redeemScript: request.covenantRedeemScript, value: request.stakeSompi };
      covenantEntry = 'refund';
    } else if (action === 'fallback_claim') {
      if (confirmedReveals.length !== 1 || confirmedReveals[0].playerAddress !== player.address) throw new ProtocolError('ACTION_UNAVAILABLE', 'Only the first revealer can claim the timeout pot');
      current = await this.#currentGameUtxo(gameRecord, request, confirmedReveals);
      if (current.currentDaaScore < BigInt(current.entry.blockDaaScore) + FALLBACK_CLAIM_DAA_OFFSET) throw new ProtocolError('ACTION_UNAVAILABLE', 'The opponent still has time to reveal');
      current.value = request.stakeSompi * 2n;
      covenantEntry = 'fallback_claim';
      sequence = FALLBACK_CLAIM_DAA_OFFSET;
    } else if (action === 'refund_player') {
      if (!gameRecord.join || confirmedReveals.length > 0) throw new ProtocolError('ACTION_UNAVAILABLE', 'Refunds require a joined game with no reveals');
      if (confirmedRefunds.some((item) => item.playerAddress === player.address)) throw new ProtocolError('ALREADY_REFUNDED', 'This player already received a refund');
      if (confirmedRefunds.length === 0) {
        current = await this.#currentGameUtxo(gameRecord, request, []);
      } else {
        const firstRefund = confirmedRefunds[0];
        const found = await this.#expectedUtxo({ transactionId: firstRefund.transactionId, address: firstRefund.continuationAddress, scriptPublicKey: firstRefund.continuationScriptPublicKey, outputIndex: 1 }, request.stakeSompi);
        current = { ...found, transactionId: firstRefund.transactionId, outputIndex: 1, redeemScript: firstRefund.continuationRedeemScript, joinedDaaScore: BigInt(found.entry.blockDaaScore) };
      }
      if (current.currentDaaScore < BigInt(current.entry.blockDaaScore) + NO_REVEAL_REFUND_DAA_OFFSET) throw new ProtocolError('ACTION_UNAVAILABLE', 'The no-reveal refund wait has not elapsed');
      current.value = confirmedRefunds.length === 0 ? request.stakeSompi * 2n : request.stakeSompi;
      covenantEntry = 'refund_player';
      sequence = NO_REVEAL_REFUND_DAA_OFFSET;
      if (confirmedRefunds.length === 0) {
        continuation = deriveGameInstance({
          creatorPubkey: request.creatorPublicKey,
          creatorCommit: request.creatorCommitment,
          joinerPubkey: gameRecord.join.joinerPublicKey,
          joinerCommit: gameRecord.join.joinerCommitment,
          potSompi: request.stakeSompi,
          deadlineDaa: request.deadlineDaa,
          creatorEven: request.creatorEven,
          status: player.role === 'creator' ? 5 : 6,
        });
        continuationOutputIndex = 1;
      }
    } else {
      throw new ProtocolError('UNSUPPORTED_ACTION', 'Unsupported safety action');
    }

    const feeSompi = 4_200_000n;
    const funding = await this.#actionFunding(player.address, feeSompi);
    const prepared = prepareTerminalTransaction({
      action: covenantEntry,
      gameInput: { ...current.entry, transactionId: current.transactionId, index: current.outputIndex ?? 0, amount: current.value, covenantId: gameRecord.join?.covenantId ?? deserializePrepared(gameRecord.prepared).covenantId, redeemScript: current.redeemScript },
      inputSequence: sequence,
      lockTime: action === 'creator_refund' ? request.deadlineDaa : 0n,
      args: [publicKey],
      payoutValue: action === 'fallback_claim' ? request.stakeSompi * 2n : request.stakeSompi,
      recipientScriptPublicKey: playerScriptPublicKey(publicKey),
      extraOutputs: continuation ? [{ value: request.stakeSompi, scriptPublicKey: `0000${continuation.p2shScript.toString('hex')}`, covenant: { authorizingInput: 0, covenantId: gameRecord.join.covenantId } }] : [],
      feeInputs: funding.inputs,
      feeSompi,
      change: funding.change,
    });
    const txJson = serializeTerminalTransaction(prepared);
    const preparedHash = Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex');
    const record = {
      preparedHash, action, gameId: id, playerAddress: player.address, role: player.role,
      txJson, transaction: prepared.transaction, feeSompi: String(feeSompi),
      continuationAddress: continuation?.address,
      continuationScriptPublicKey: continuation ? `0000${continuation.p2shScript.toString('hex')}` : undefined,
      continuationRedeemScript: continuation?.redeemScript.toString('hex'),
      continuationOutputIndex,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveActionPrepared(record);
    return { gameId: id, preparedHash, txJson, feeSompi: String(feeSompi), action };
  }

  async submitSafetyAction(gameId, action, { preparedHash, signedTxJson }) {
    const id = validateGameId(gameId);
    const prepared = await this.store.loadActionPrepared(preparedHash);
    if (!prepared || prepared.gameId !== id || prepared.action !== action) throw new ProtocolError('PREPARATION_NOT_FOUND', 'Action preparation was not found');
    const gameRecord = await this.store.loadGame(id);
    verifySignedTerminalTransaction({ prepared: { transaction: prepared.transaction }, signedTxJson });
    const transactionId = validateGameId(await this.rpc.submitSafeJson(signedTxJson));
    const terminal = {
      action, transactionId, preparedHash, playerAddress: prepared.playerAddress, role: prepared.role,
      status: 'broadcast', continuationAddress: prepared.continuationAddress,
      continuationScriptPublicKey: prepared.continuationScriptPublicKey,
      continuationRedeemScript: prepared.continuationRedeemScript,
      continuationOutputIndex: prepared.continuationOutputIndex,
      submittedAt: new Date().toISOString(),
    };
    await this.store.saveGame({ ...gameRecord, status: `${action}_broadcast`, safetyActions: [...(gameRecord.safetyActions ?? []), terminal] });
    return { gameId: id, transactionId, status: `${action}_broadcast` };
  }

  async readGame(gameId) {
    const id = validateGameId(gameId);
    const record = await this.store.loadGame(id);
    if (!record) throw new ProtocolError('GAME_NOT_FOUND', 'Game was not prepared by this backend');
    let refreshed = record.join ? await this.#refreshActionState(record) : record;
    refreshed = await this.#refreshSafetyState(refreshed);
    const request = deserializeRequest(refreshed.request);
    const prepared = deserializePrepared(refreshed.prepared);
    const safetyStatus = ['fallback_claimed', 'refunded', 'creator_refunded', 'refund_partial'].includes(refreshed.status);
    const confirmation = safetyStatus || ['first_revealed', 'settled'].includes(refreshed.status)
      ? { status: 'confirmed' }
      : refreshed.join
      ? await this.#confirmJoin(refreshed, request)
      : await this.#chain(request, 1).confirmCreation({ transactionId: id, request, prepared });
    const confirmedReveals = (refreshed.reveals ?? []).filter((reveal) => reveal.status === 'confirmed');
    const status = safetyStatus ? refreshed.status
      : refreshed.status === 'settled' ? 'settled'
      : confirmedReveals.length === 1 ? 'first_revealed'
      : refreshed.join
        ? (confirmation.status === 'confirmed' ? 'joined' : refreshed.status)
      : (confirmation.status === 'confirmed' ? 'waiting_for_player_b' : confirmation.status);
    if (status !== refreshed.status) await this.store.saveGame({ ...refreshed, status, confirmation, updatedAt: new Date().toISOString() });
    return {
      gameId: id,
      network: NETWORK,
      status,
      confirmationStatus: confirmation.status,
      stakeKas: Number(request.stakeSompi / 100_000_000n),
      creator: { address: request.creatorAddress, side: request.side },
      joiner: refreshed.join ? { address: refreshed.join.joinerAddress } : null,
      deadlineDaa: String(request.deadlineDaa),
      inviteUrl: `/join?v=${encodeURIComponent(PROTOCOL_VERSION)}&game=${id}`,
      canJoin: status === 'waiting_for_player_b',
      joinTransactionId: refreshed.join?.transactionId,
      revealCount: confirmedReveals.length,
      firstRevealer: confirmedReveals[0]?.playerAddress,
      winner: refreshed.winner,
      winnerAddress: refreshed.winner === 'creator' ? request.creatorAddress : refreshed.winner === 'joiner' ? refreshed.join?.joinerAddress : null,
      matchmaking: Boolean(refreshed.matchId),
      revealedPicks: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.role, reveal.choice])),
      canReveal: ['joined', 'first_revealed'].includes(status),
      safetyAction: status === 'first_revealed' ? 'fallback_claim'
        : status === 'joined' || status === 'refund_partial' ? 'refund_player'
        : status === 'waiting_for_player_b' ? 'creator_refund' : null,
    };
  }

  #player(record, request, address, publicKey) {
    if (address === request.creatorAddress && publicKey === request.creatorPublicKey) {
      return { role: 'creator', address, publicKey, commitment: request.creatorCommitment };
    }
    if (address === record.join.joinerAddress && publicKey === record.join.joinerPublicKey) {
      return { role: 'joiner', address, publicKey, commitment: record.join.joinerCommitment };
    }
    throw new ProtocolError('NOT_A_PLAYER', 'The connected Kastle account is not a player in this game');
  }

  #creator(request, address, publicKey) {
    if (address !== request.creatorAddress || publicKey !== request.creatorPublicKey) throw new ProtocolError('NOT_A_PLAYER', 'Only Player A can refund this game');
    return { role: 'creator', address, publicKey, commitment: request.creatorCommitment };
  }

  #matchmakingAddress(value) {
    if (typeof value !== 'string' || !value.startsWith('kaspatest:')) throw new ProtocolError('INVALID_ADDRESS', 'Matchmaking requires a testnet wallet');
    return value;
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
    const creatorIndex = match.creatorIndex;
    const creatorSide = match.creatorSide;
    const isCreator = match.status !== 'waiting' && index === creatorIndex;
    const side = creatorSide === (isCreator ? 'even' : 'odd') ? 'even' : 'odd';
    return {
      matchId: match.matchId,
      status: match.status,
      role: match.status === 'waiting' ? null : isCreator ? 'creator' : 'joiner',
      side: match.status === 'waiting' ? null : side,
      gameId: match.gameId ?? null,
      stakeKas: MATCH_STAKE_KAS,
      ready: match.status === 'ready' || match.status === 'started',
      opponentConnected: match.players.length === 2,
      voteLocked: Boolean(match.players[index].commitment),
    };
  }

  async #attachMatchGame(matchId, creatorAddress, gameId) {
    const match = await this.store.loadMatch(matchId);
    if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
    const creator = this.#matchPlayer(match, creatorAddress);
    const creatorIndex = match.players.indexOf(creator);
    if (!['matched', 'ready'].includes(match.status) || creatorIndex !== match.creatorIndex || !creator.commitment) {
      throw new ProtocolError('MATCH_NOT_READY', 'The creator vote must be locked first');
    }
    await this.store.updateMatch(matchId, (current) => { current.gameId = gameId; current.status = 'started'; });
  }

  async #validateMatchCreation(input) {
    const match = await this.store.loadMatch(input.matchId);
    const player = this.#matchPlayer(match, input.creatorAddress);
    const playerIndex = match.players.indexOf(player);
    const assignedSide = match.creatorSide === (playerIndex === match.creatorIndex ? 'even' : 'odd') ? 'even' : 'odd';
    if (match.status !== 'ready' || playerIndex !== match.creatorIndex || input.stakeKas !== MATCH_STAKE_KAS || input.side !== assignedSide || player.commitment !== input.creatorCommitment) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready to start');
    }
  }

  async #validateMatchJoin(matchId, gameId, address) {
    const match = await this.store.loadMatch(matchId);
    const player = this.#matchPlayer(match, address);
    const playerIndex = match.players.indexOf(player);
    if (match.status !== 'started' || match.gameId !== gameId || playerIndex === match.creatorIndex) {
      throw new ProtocolError('MATCH_NOT_READY', 'This matchmaking game is not ready for you');
    }
  }

  async #actionFunding(address, feeSompi) {
    const response = await this.rpc.getUtxosByAddresses([address]);
    const entries = response.entries ?? response;
    const { selected } = selectOrdinaryUtxos({ utxos: entries, targetSompi: feeSompi + 1n });
    const inputs = entries.filter((entry) => selected.some((item) => {
      const outpoint = entry.outpoint ?? entry;
      return outpoint.transactionId.toLowerCase() === item.transactionId && outpoint.index === item.index;
    }));
    const total = inputs.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    return { inputs, change: { value: total - feeSompi, scriptPublicKey: inputs[0].scriptPublicKey } };
  }

  #revealGameState(gameId, record, request, current, confirmedReveals) {
    const first = confirmedReveals[0];
    return {
      gameId,
      network: NETWORK,
      confirmationStatus: 'confirmed',
      joinedDaaScore: current.joinedDaaScore,
      currentDaaScore: current.currentDaaScore,
      creatorAddress: request.creatorAddress,
      joinerAddress: record.join.joinerAddress,
      creatorEven: request.creatorEven,
      creatorChoice: first?.role === 'creator' ? first.choice : 0,
      joinerChoice: first?.role === 'joiner' ? first.choice : 0,
      potSompi: request.stakeSompi * 2n,
      participants: {
        [request.creatorAddress]: { commitment: request.creatorCommitment },
        [record.join.joinerAddress]: { commitment: record.join.joinerCommitment },
      },
      reveals: Object.fromEntries(confirmedReveals.map((reveal) => [reveal.playerAddress, true])),
      firstReveal: first ? { player: first.playerAddress, confirmedDaaScore: first.confirmedDaaScore } : null,
    };
  }

  async #currentGameUtxo(record, request, confirmedReveals) {
    const first = confirmedReveals[0];
    const descriptor = first
      ? { transactionId: first.transactionId, address: first.continuationAddress, scriptPublicKey: first.continuationScriptPublicKey, redeemScript: first.continuationRedeemScript }
      : { transactionId: record.join.transactionId, address: record.join.joinedAddress, scriptPublicKey: record.join.joinedScriptPublicKey, redeemScript: record.join.joinedRedeemScript };
    const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, request.stakeSompi * 2n);
    return { entry, currentDaaScore, joinedDaaScore: BigInt(entry.blockDaaScore), transactionId: descriptor.transactionId, redeemScript: descriptor.redeemScript };
  }

  async #refreshActionState(record) {
    const reveals = [...(record.reveals ?? [])];
    const pending = reveals.find((reveal) => reveal.status !== 'confirmed');
    if (!pending) return record;
    const request = deserializeRequest(record.request);
    const descriptor = pending.winner
      ? { transactionId: pending.transactionId, address: pending.payoutAddress, scriptPublicKey: playerScriptPublicKey(pending.winner === 'creator' ? request.creatorPublicKey : record.join.joinerPublicKey), outputIndex: pending.winner === 'creator' ? 0 : 1 }
      : { transactionId: pending.transactionId, address: pending.continuationAddress, scriptPublicKey: pending.continuationScriptPublicKey, outputIndex: 0 };
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, pending.winner ? request.stakeSompi * 2n : request.stakeSompi * 2n);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return record;
      const index = reveals.indexOf(pending);
      reveals[index] = { ...pending, status: 'confirmed', confirmedDaaScore: String(currentDaaScore) };
      const updated = { ...record, reveals, status: pending.winner ? 'settled' : 'first_revealed', ...(pending.winner ? { winner: pending.winner } : {}) };
      await this.store.saveGame(updated);
      return updated;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return record;
      throw error;
    }
  }

  async #refreshSafetyState(record) {
    const actions = [...(record.safetyActions ?? [])];
    const pending = actions.find((item) => item.status !== 'confirmed');
    if (!pending) return record;
    const request = deserializeRequest(record.request);
    const publicKey = pending.role === 'creator' ? request.creatorPublicKey : record.join?.joinerPublicKey;
    const value = pending.action === 'fallback_claim' ? request.stakeSompi * 2n : request.stakeSompi;
    const descriptor = pending.continuationAddress
      ? { transactionId: pending.transactionId, address: pending.continuationAddress, scriptPublicKey: pending.continuationScriptPublicKey, outputIndex: pending.continuationOutputIndex ?? 1 }
      : { transactionId: pending.transactionId, address: pending.playerAddress, scriptPublicKey: playerScriptPublicKey(publicKey), outputIndex: 0 };
    try {
      const { entry, currentDaaScore } = await this.#expectedUtxo(descriptor, value);
      if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) return record;
      const index = actions.indexOf(pending);
      actions[index] = { ...pending, status: 'confirmed', confirmedDaaScore: String(currentDaaScore) };
      const refundCount = actions.filter((item) => item.action === 'refund_player' && item.status === 'confirmed').length;
      const status = pending.action === 'fallback_claim' ? 'fallback_claimed'
        : pending.action === 'creator_refund' ? 'creator_refunded'
        : refundCount >= 2 ? 'refunded' : 'refund_partial';
      const updated = { ...record, safetyActions: actions, status };
      await this.store.saveGame(updated);
      return updated;
    } catch (error) {
      if (error?.code === 'ACTION_NOT_CONFIRMED') return record;
      throw error;
    }
  }

  async #expectedUtxo(descriptor, valueSompi) {
    const [utxos, dag] = await Promise.all([this.rpc.getUtxosByAddresses([descriptor.address]), this.rpc.getBlockDagInfo()]);
    const outputIndex = descriptor.outputIndex ?? 0;
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === descriptor.transactionId && outpoint.index === outputIndex
        && BigInt(candidate.amount) === valueSompi && candidate.scriptPublicKey === descriptor.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('ACTION_NOT_CONFIRMED', 'The expected game output is not available yet');
    return { entry, currentDaaScore: BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString) };
  }

  async #openCreationUtxo(gameId, request, prepared) {
    const [utxos, dag] = await Promise.all([
      this.rpc.getUtxosByAddresses([request.covenantAddress]),
      this.rpc.getBlockDagInfo(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === gameId && outpoint.index === 0
        && BigInt(candidate.amount) === request.stakeSompi
        && candidate.scriptPublicKey === prepared.scriptPublicKey;
    });
    if (!entry) throw new ProtocolError('GAME_NOT_OPEN', 'The game deposit is no longer available');
    const currentDaaScore = BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
    if (currentDaaScore < BigInt(entry.blockDaaScore) + 1n) throw new ProtocolError('GAME_NOT_CONFIRMED', 'The game deposit is still confirming');
    return { entry, currentDaaScore };
  }

  async #confirmJoin(record, request) {
    const [utxos, dag] = await Promise.all([
      this.rpc.getUtxosByAddresses([record.join.joinedAddress]),
      this.rpc.getBlockDagInfo(),
    ]);
    const entry = (utxos.entries ?? utxos).find((candidate) => {
      const outpoint = candidate.outpoint ?? candidate;
      return outpoint.transactionId === record.join.transactionId && outpoint.index === 0
        && BigInt(candidate.amount) === request.stakeSompi * 2n
        && candidate.scriptPublicKey === record.join.joinedScriptPublicKey;
    });
    if (!entry) return { status: 'observed' };
    const currentDaaScore = BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
    return { status: currentDaaScore >= BigInt(entry.blockDaaScore) + 1n ? 'confirmed' : 'observed' };
  }

  #chain(request, attempts = 30) {
    return new KaspaChainAdapter({
      rpc: this.rpc,
      covenantAddress: request.covenantAddress,
      scriptPublicKey: request.covenantScriptPublicKey,
      confidenceAttempts: attempts,
      confidenceIntervalMs: attempts === 1 ? 0 : 2_000,
    });
  }
}

function normalizeHex(value, bytes, name) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}

function playerScriptPublicKey(publicKey) {
  return `000020${normalizePublicKey(publicKey)}ac`;
}

function serializeRequest(request) {
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

function deserializeRequest(request) {
  return { ...request, stakeSompi: BigInt(request.stakeSompi), feeSompi: BigInt(request.feeSompi), deadlineDaa: BigInt(request.deadlineDaa) };
}

function serializePrepared(prepared) {
  return JSON.parse(JSON.stringify(prepared, (_, value) => typeof value === 'bigint' ? String(value) : value));
}

function deserializePrepared(prepared) {
  return { ...prepared, feeSompi: BigInt(prepared.feeSompi), policy: deserializePolicy(prepared.policy) };
}

function deserializePolicy(policy) {
  return Object.fromEntries(Object.entries(policy ?? {}).map(([key, value]) => [key, /Sompi$/.test(key) && typeof value === 'string' ? BigInt(value) : value]));
}
