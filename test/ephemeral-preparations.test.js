import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralPreparations } from '../src/ephemeral-preparations.js';

test('saves and loads a preparation by hash', () => {
  const store = new EphemeralPreparations();
  store.save({ preparedHash: 'ab', gameId: 'c'.repeat(64), action: 'reveal', choice: 1 });
  assert.deepEqual(store.load('ab'), { preparedHash: 'ab', gameId: 'c'.repeat(64), action: 'reveal', choice: 1 });
  assert.equal(store.size(), 1);
});

test('returns null for an unknown or expired preparation', () => {
  let now = 1_000;
  const store = new EphemeralPreparations({ ttlMs: 100, now: () => now });
  store.save({ preparedHash: 'expired' });
  now += 101;
  assert.equal(store.load('expired'), null);
  assert.equal(store.size(), 0);
});

test('evicts the oldest entry past the maximum size', () => {
  const store = new EphemeralPreparations({ maxEntries: 2 });
  store.save({ preparedHash: 'one' });
  store.save({ preparedHash: 'two' });
  store.save({ preparedHash: 'three' });
  assert.equal(store.load('one'), null);
  assert.deepEqual(store.load('two'), { preparedHash: 'two' });
  assert.deepEqual(store.load('three'), { preparedHash: 'three' });
});

test('returns a clone so callers cannot mutate stored records', () => {
  const store = new EphemeralPreparations();
  store.save({ preparedHash: 'x', nested: { value: 1 } });
  const loaded = store.load('x');
  loaded.nested.value = 99;
  assert.equal(store.load('x').nested.value, 1);
});

test('delete removes a preparation', () => {
  const store = new EphemeralPreparations();
  store.save({ preparedHash: 'x' });
  store.delete('x');
  assert.equal(store.load('x'), null);
});
