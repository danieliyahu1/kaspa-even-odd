import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameStore } from '../src/backend-game-store.js';

test('backend game state survives store recreation without persisting signed transactions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-store-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preparedHash = 'a'.repeat(64);
  const gameId = 'b'.repeat(64);

  const store = new BackendGameStore(filePath);
  await store.savePrepared({ preparedHash, txJson: 'unsigned' });
  await store.saveGame({ gameId, network: 'testnet-10', status: 'broadcast' });

  const restartedStore = new BackendGameStore(filePath);
  assert.deepEqual(await restartedStore.loadPrepared(preparedHash), { preparedHash, txJson: 'unsigned' });
  assert.deepEqual(await restartedStore.loadGame(gameId), { gameId, network: 'testnet-10', status: 'broadcast' });
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /signedTxJson|signatureScript/);
});

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

  await store.updateMatch('first-match', (match) => { match.players[0].commitment = 'c'.repeat(64); });
  assert.equal((await store.loadMatch('first-match')).players[0].commitment, 'c'.repeat(64));
  await store.leaveMatch('first-match', 'kaspatest:first');
  assert.equal((await store.loadMatch('first-match')).status, 'cancelled');
});
