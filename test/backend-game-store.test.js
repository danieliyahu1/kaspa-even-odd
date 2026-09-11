import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameStore } from '../src/backend-game-store.js';

test('matchmaking pairs two wallets and keeps the queue private to the store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-match-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);
  const first = await store.joinMatchmaking({ matchId: 'first-match', address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  assert.equal(first.status, 'waiting');
  assert.equal(first.players.length, 1);

  const second = await store.joinMatchmaking({ matchId: 'second-match', address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  assert.equal(second.status, 'matched');
  assert.equal(second.players.length, 2);
  assert.ok(['even', 'odd'].includes(second.creatorSide));
  assert.ok([0, 1].includes(second.creatorIndex));
  assert.deepEqual((await store.loadMatch('first-match')).players.map(({ address }) => address), ['kaspatest:first', 'kaspatest:second']);

  await store.updateMatch('first-match', (match) => { match.status = 'started'; match.creation = { gameId: 'd'.repeat(64) }; });
  const updated = await store.loadMatch('first-match');
  assert.equal(updated.status, 'started');
  assert.equal(updated.creation.gameId, 'd'.repeat(64));

  await store.leaveMatch('first-match', 'kaspatest:first');
  assert.deepEqual((await store.loadMatch('first-match')).players.map(({ address }) => address), ['kaspatest:second']);
});
