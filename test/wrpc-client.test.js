import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUtxoEntry } from '../src/wrpc-client.js';

test('normalizes getter-backed WASM UTXO fields into an ordinary object', () => {
  const outpoint = { transactionId: 'ab'.repeat(32), index: 1 };
  const prototype = {
    get amount() { return 150_000_000n; },
    get scriptPublicKey() { return { version: 0, script: '20aaac' }; },
    get blockDaaScore() { return 42n; },
    get isCoinbase() { return false; },
    get covenantId() { return null; },
  };
  const entry = { outpoint, entry: Object.create(prototype) };

  const normalized = normalizeUtxoEntry(entry);

  assert.deepEqual(normalized, {
    outpoint,
    amount: 150_000_000n,
    scriptPublicKey: '000020aaac',
    blockDaaScore: 42n,
    isCoinbase: false,
    covenantId: null,
  });
  assert.equal(Object.hasOwn(normalized, 'amount'), true);
});
