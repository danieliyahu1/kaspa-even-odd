import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';

const NO_UTXO_RPC = {
  getBlockDagInfo: async () => ({ virtualDaaScore: '100' }),
  getUtxosByAddresses: async () => ({ entries: [] }),
  getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
};

const GAME_FEE_PUBLIC_KEY = '11'.repeat(32);

function serviceOptions(store) {
  return { rpc: {}, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY };
}

test('matchmaking pairs wallets and assigns each a role and side', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  assert.equal(first.status, 'waiting');
  assert.equal(first.role, null);
  const second = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });

  assert.equal(second.status, 'matched');
  assert.equal(second.opponentConnected, true);
  assert.ok(['creator', 'joiner'].includes(second.role));
  assert.ok(['even', 'odd'].includes(second.side));

  const firstStatus = await service.matchmakingStatus(first.matchId, 'kaspatest:first');
  assert.equal(firstStatus.matchId, second.matchId);
  assert.equal(firstStatus.role === 'creator' ? 'joiner' : 'creator', second.role);
});

test('only the match creator may start the game, with the assigned side', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: NO_UTXO_RPC, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  const { creatorAddress, joinerAddress, creatorPublicKey, creatorView } = await matchRoles(service, first.matchId);

  const base = { matchId: first.matchId, creatorAddress, creatorPublicKey, creatorCommitment: 'e'.repeat(64), side: creatorView.side, stakeKas: 1 };
  // The joiner is not the creator.
  await assert.rejects(service.prepareCreation({ ...base, creatorAddress: joinerAddress }), { code: 'MATCH_NOT_READY' });
  // The creator must use the assigned side.
  await assert.rejects(service.prepareCreation({ ...base, side: creatorView.side === 'even' ? 'odd' : 'even' }), { code: 'MATCH_NOT_READY' });
  // A valid creator request proceeds to chain work (empty wallet UTXOs).
  await assert.rejects(service.prepareCreation(base), { code: 'NO_UTXOS' });
});

test('submitting an unknown creation preparation is rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  await assert.rejects(
    service.submitCreation({ preparedHash: 'ab'.repeat(32), signedTxJson: '{}', matchId: null }),
    { code: 'PREPARATION_NOT_FOUND' },
  );
});

test('join, reveal, and read require an existing game', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  const gameId = 'f'.repeat(64);
  await assert.rejects(
    service.prepareJoin(gameId, { joinerAddress: 'kaspatest:x', joinerPublicKey: 'a'.repeat(64), joinerCommitment: 'b'.repeat(64) }),
    { code: 'GAME_NOT_FOUND' },
  );
  await assert.rejects(
    service.prepareReveal(gameId, { playerAddress: 'kaspatest:x', playerPublicKey: 'a'.repeat(64), choice: 1, nonceHex: 'c'.repeat(64) }),
    { code: 'GAME_NOT_JOINED' },
  );
  await assert.rejects(service.readGame(gameId), { code: 'GAME_NOT_FOUND' });
  await assert.rejects(
    service.prepareSafetyAction(gameId, 'refund_player', { playerAddress: 'kaspatest:x', playerPublicKey: 'a'.repeat(64) }),
    { code: 'GAME_NOT_FOUND' },
  );
});

test('network status is served without touching the node or exposing a browser wRPC URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = { getBlockDagInfo: async () => { throw new Error('networkStatus must not query the node'); } };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const status = await service.networkStatus();
  assert.equal(status.network, 'testnet-10');
  assert.equal(status.protocolVersion, 'EO/v4');
  assert.equal(status.gameFeePublicKey, GAME_FEE_PUBLIC_KEY);
  assert.equal(status.wrpcUrl, undefined);
});

async function matchRoles(service, matchId) {
  const firstView = await service.matchmakingStatus(matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const joinerAddress = creatorAddress === 'kaspatest:first' ? 'kaspatest:second' : 'kaspatest:first';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(matchId, creatorAddress);
  return { creatorAddress, joinerAddress, creatorPublicKey, creatorView };
}
