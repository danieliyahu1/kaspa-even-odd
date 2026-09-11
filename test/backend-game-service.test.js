import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';

test('matchmaking pairs wallets and assigns each a role and side', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: {}, store: new BackendGameStore(join(directory, 'games.json')) });
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

test('the match creator publishes a creation the paired joiner can read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: {}, store: new BackendGameStore(join(directory, 'games.json')) });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  const { creatorAddress, joinerAddress, creatorView } = await matchRoles(service, first.matchId);
  const creation = {
    gameId: 'f'.repeat(64),
    creatorPublicKey: creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64),
    creatorCommitment: 'e'.repeat(64),
    side: creatorView.side,
    stakeKas: 1,
    deadlineDaa: '1000',
    creatorAddress,
  };

  await service.publishCreation(first.matchId, { address: creatorAddress, creation });

  const joinerView = await service.matchmakingStatus(first.matchId, joinerAddress);
  assert.equal(joinerView.status, 'started');
  assert.equal(joinerView.gameId, creation.gameId);
  assert.equal(joinerView.creation.creatorCommitment, creation.creatorCommitment);
  assert.equal(joinerView.creation.deadlineDaa, '1000');
});

test('only the creator can publish, and the side must match the assignment', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: {}, store: new BackendGameStore(join(directory, 'games.json')) });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  const { creatorAddress, joinerAddress, creatorView } = await matchRoles(service, first.matchId);
  const creation = {
    gameId: 'f'.repeat(64),
    creatorPublicKey: creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64),
    creatorCommitment: 'e'.repeat(64),
    side: creatorView.side,
    stakeKas: 1,
    deadlineDaa: '1000',
    creatorAddress,
  };

  await assert.rejects(
    service.publishCreation(first.matchId, { address: joinerAddress, creation }),
    { code: 'NOT_A_PLAYER' },
  );
  await assert.rejects(
    service.publishCreation(first.matchId, { address: creatorAddress, creation: { ...creation, side: creatorView.side === 'even' ? 'odd' : 'even' } }),
    { code: 'INVALID_GAME_STATE' },
  );
});

async function matchRoles(service, matchId) {
  const firstView = await service.matchmakingStatus(matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const joinerAddress = creatorAddress === 'kaspatest:first' ? 'kaspatest:second' : 'kaspatest:first';
  const creatorView = await service.matchmakingStatus(matchId, creatorAddress);
  return { creatorAddress, joinerAddress, creatorView };
}

test('network status is served without touching the node', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = { getBlockDagInfo: async () => { throw new Error('networkStatus must not query the node'); } };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')) });

  const previous = process.env.KASPA_WRPC_BROWSER_URL;
  try {
    delete process.env.KASPA_WRPC_BROWSER_URL;
    const status = await service.networkStatus();
    assert.equal(status.network, 'testnet-10');
    assert.equal(status.virtualDaaScore, undefined);
    // Default must be a wss:// URL: the web SDK resolver returns https://
    // endpoints that browsers block via CORS.
    assert.match(status.wrpcUrl, /^wss:\/\//);
    process.env.KASPA_WRPC_BROWSER_URL = 'wss://example.test/kaspa/testnet-10/wrpc/borsh';
    assert.equal((await service.networkStatus()).wrpcUrl, 'wss://example.test/kaspa/testnet-10/wrpc/borsh');
  } finally {
    if (previous === undefined) delete process.env.KASPA_WRPC_BROWSER_URL;
    else process.env.KASPA_WRPC_BROWSER_URL = previous;
  }
});
