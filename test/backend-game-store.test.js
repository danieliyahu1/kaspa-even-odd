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
