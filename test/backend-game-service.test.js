import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';

test('matchmaking service pairs wallets and requires both hidden votes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: {}, store: new BackendGameStore(join(directory, 'games.json')) });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await assert.rejects(
    service.submitMatchVote(first.matchId, { address: 'kaspatest:first', commitment: 'c'.repeat(64) }),
    { code: 'MATCH_NOT_READY' },
  );
  const second = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });

  assert.equal(first.status, 'waiting');
  assert.equal(second.status, 'matched');
  assert.ok(['creator', 'joiner'].includes(second.role));
  assert.ok(['even', 'odd'].includes(second.side));

  const firstStatus = await service.matchmakingStatus(first.matchId, 'kaspatest:first');
  await service.submitMatchVote(first.matchId, { address: 'kaspatest:first', commitment: 'c'.repeat(64) });
  assert.equal((await service.matchmakingStatus(first.matchId, 'kaspatest:first')).ready, false);
  await service.submitMatchVote(first.matchId, { address: 'kaspatest:second', commitment: 'd'.repeat(64) });
  assert.equal((await service.matchmakingStatus(first.matchId, 'kaspatest:first')).ready, true);
  assert.equal(firstStatus.matchId, second.matchId);
});

test('matchmaking creation accepts the durable game commitment after the transient vote', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = {
    getBlockDagInfo: async () => ({ virtualDaaScore: '100' }),
    getUtxosByAddresses: async () => ({ entries: [] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
  };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')) });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  await service.submitMatchVote(first.matchId, { address: 'kaspatest:first', commitment: 'c'.repeat(64) });
  await service.submitMatchVote(first.matchId, { address: 'kaspatest:second', commitment: 'd'.repeat(64) });

  const firstView = await service.matchmakingStatus(first.matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(first.matchId, creatorAddress);

  // The durable on-chain commitment is fresh; it never equals the transient vote
  // commitment. Validation must pass and preparation must proceed to chain work.
  await assert.rejects(
    service.prepareCreation({
      matchId: first.matchId,
      creatorAddress,
      creatorPublicKey,
      creatorCommitment: 'e'.repeat(64),
      side: creatorView.side,
      stakeKas: 1,
    }),
    (error) => error.code === 'NO_UTXOS',
  );
});

test('matchmaking creation starts as soon as the creator locks a vote', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = {
    getBlockDagInfo: async () => ({ virtualDaaScore: '100' }),
    getUtxosByAddresses: async () => ({ entries: [] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
  };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')) });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });

  const firstView = await service.matchmakingStatus(first.matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(first.matchId, creatorAddress);

  // Only the creator votes; the joiner has not picked a number yet.
  await service.submitMatchVote(first.matchId, { address: creatorAddress, commitment: 'c'.repeat(64) });

  // The creator must be able to lock the game now, not once the joiner votes.
  await assert.rejects(
    service.prepareCreation({
      matchId: first.matchId,
      creatorAddress,
      creatorPublicKey,
      creatorCommitment: 'e'.repeat(64),
      side: creatorView.side,
      stakeKas: 1,
    }),
    (error) => error.code === 'NO_UTXOS',
  );
});

test('network status exposes a browser-usable wRPC endpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = { getBlockDagInfo: async () => ({ virtualDaaScore: '100' }) };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')) });

  const previous = process.env.KASPA_WRPC_BROWSER_URL;
  try {
    delete process.env.KASPA_WRPC_BROWSER_URL;
    const status = await service.networkStatus();
    assert.equal(status.network, 'testnet-10');
    assert.equal(status.virtualDaaScore, '100');
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
