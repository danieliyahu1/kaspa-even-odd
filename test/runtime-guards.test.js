import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.js';
import { RelayStore } from '../src/relay-store.js';
import { RateLimiter } from '../src/rate-limit.js';
import { EphemeralPreparations } from '../src/ephemeral-preparations.js';

test('metrics render valid Prometheus text with bounded labels and no identities', () => {
  const metrics = new Metrics();
  metrics.recordHttp({ method: 'POST', route: '/api/games/:id/:stage/:step', status: 502, durationSeconds: 0.2 });
  metrics.recordRpc({ operation: 'submitSafeJson', outcome: 'error', durationSeconds: 1.5 });
  metrics.setMatchmakingWaiting(2);

  const text = metrics.render();
  assert.match(text, /# TYPE kaspa_http_requests_total counter/);
  assert.match(text, /kaspa_http_requests_total\{method="POST",route="\/api\/games\/:id\/:stage\/:step",status="502"\} 1/);
  assert.match(text, /kaspa_http_errors_total\{/);
  assert.match(text, /# TYPE kaspa_http_request_duration_seconds histogram/);
  assert.match(text, /kaspa_http_request_duration_seconds_bucket\{le="\+Inf",.*\} 1/);
  assert.match(text, /kaspa_rpc_requests_total\{operation="submitSafeJson",outcome="error"\} 1/);
  assert.match(text, /kaspa_matchmaking_waiting 2/);
  // No wallet addresses, game ids, transaction ids, or raw URLs may leak.
  assert.doesNotMatch(text, /kaspatest:|[0-9a-f]{64}/);
});

test('relay store rejects oversized payloads, expires entries, and caps its size', () => {
  let now = 0;
  const relay = new RelayStore({ maxEntries: 2, maxPayloadBytes: 32, ttlMs: 1000, now: () => now });
  relay.set('a'.repeat(64), { ok: true });
  relay.set('b'.repeat(64), { ok: true });
  relay.set('c'.repeat(64), { ok: true });
  assert.equal(relay.size(), 2, 'oldest entry is evicted at capacity');
  assert.equal(relay.get('a'.repeat(64)), null);

  assert.throws(() => relay.set('d'.repeat(64), { blob: 'x'.repeat(100) }), (error) => error.code === 'RELAY_PAYLOAD_TOO_LARGE');

  now = 2000;
  assert.equal(relay.get('b'.repeat(64)), null, 'entries expire after the TTL');
  assert.equal(relay.size(), 0);
});

test('rate limiter allows up to the limit then reports a retry window', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.deepEqual(limiter.check('client'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check('client'), { allowed: true, retryAfterSeconds: 0 });
  const blocked = limiter.check('client');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.check('other').allowed, true, 'limits are per client');

  now = 1500;
  assert.equal(limiter.check('client').allowed, true, 'the window resets');
});

test('ephemeral preparations expire reveal secrets instead of persisting them', () => {
  let now = 0;
  const store = new EphemeralPreparations({ ttlMs: 500, maxEntries: 1, now: () => now });
  const record = { preparedHash: 'a'.repeat(64), action: 'reveal', nonceHex: '11'.repeat(32) };
  store.save(record);
  assert.deepEqual(store.load(record.preparedHash), record);

  store.save({ preparedHash: 'b'.repeat(64), action: 'reveal' });
  assert.equal(store.load(record.preparedHash), null, 'capacity evicts the oldest preparation');

  now = 1000;
  assert.equal(store.load('b'.repeat(64)), null, 'preparations expire');
  assert.equal(store.size(), 0);
});
