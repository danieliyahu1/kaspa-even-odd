import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  validateFeedback,
  formatFeedbackMessage,
  FeedbackSpill,
  TelegramFeedback,
  FeedbackService,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_MAX_PAGE,
  FEEDBACK_MAX_SCREEN,
  FEEDBACK_MAX_BROWSER,
} from '../src/feedback.js';
import { Metrics } from '../src/metrics.js';
import { bech32Encode } from '../src/hashes/bech32.mjs';

const feePublicKey = '11'.repeat(32);
const feeAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));

test('validateFeedback rejects an empty message', () => {
  assert.throws(() => validateFeedback({}), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: '' }), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: '   ' }), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: null }), { code: 'INVALID_FEEDBACK' });
});

test('validateFeedback rejects messages over the length limit', () => {
  assert.throws(() => validateFeedback({ message: 'x'.repeat(FEEDBACK_MAX_MESSAGE + 1) }), { code: 'FEEDBACK_TOO_LONG' });
});

test('validateFeedback returns trimmed, capped fields', () => {
  const result = validateFeedback({
    message: '  The reveal felt confusing  ',
    page: '/game?id=abc123',
    screen: '390x844',
    browser: 'Chrome 128',
  });
  assert.equal(result.message, 'The reveal felt confusing');
  assert.equal(result.page, '/game?id=abc123');
  assert.equal(result.screen, '390x844');
  assert.equal(result.browser, 'Chrome 128');
});

test('validateFeedback caps long fields silently', () => {
  const result = validateFeedback({
    message: 'ok',
    page: '/'.repeat(FEEDBACK_MAX_PAGE + 200),
    screen: '9'.repeat(FEEDBACK_MAX_SCREEN + 200),
    browser: 'b'.repeat(FEEDBACK_MAX_BROWSER + 200),
  });
  assert.equal(result.page.length, FEEDBACK_MAX_PAGE);
  assert.equal(result.screen.length, FEEDBACK_MAX_SCREEN);
  assert.equal(result.browser.length, FEEDBACK_MAX_BROWSER);
});

test('validateFeedback strips control characters from capped fields', () => {
  const result = validateFeedback({ message: 'good', page: '/foo\r\nbar\tx' });
  assert.ok(!result.page.includes('\r'));
  assert.ok(!result.page.includes('\n'));
  assert.ok(!result.page.includes('\t'));
});

test('formatFeedbackMessage includes only message and context, not identities', () => {
  const now = new Date('2026-09-12T18:42:00.000Z');
  const entry = { message: 'The reveal button felt off.', page: '/game', screen: '390x844', browser: 'Chrome 128' };
  const text = formatFeedbackMessage(entry, now);
  assert.ok(text.includes('New Even/Odd feedback'));
  assert.ok(text.includes('The reveal button felt off.'));
  assert.ok(text.includes('Page: /game'));
  assert.ok(text.includes('Screen: 390x844'));
  assert.ok(text.includes('Browser: Chrome 128'));
  assert.ok(text.includes('2026-09-12 18:42 UTC'));
  assert.doesNotMatch(text, /address/i);
  assert.doesNotMatch(text, /kaspatest:/);
});

test('formatFeedbackMessage omits empty fields', () => {
  const text = formatFeedbackMessage({ message: 'simple feedback' });
  assert.ok(text.includes('simple feedback'));
  assert.doesNotMatch(text, /Page:/);
  assert.doesNotMatch(text, /Screen:/);
});

test('TelegramFeedback reports enabled only when both token and chat id are set', () => {
  assert.equal(new TelegramFeedback({}).enabled, false);
  assert.equal(new TelegramFeedback({ botToken: '123' }).enabled, false);
  assert.equal(new TelegramFeedback({ chatId: '123' }).enabled, false);
  assert.equal(new TelegramFeedback({ botToken: '123', chatId: '123' }).enabled, true);
});

test('TelegramFeedback.deliver rejects when not configured', async () => {
  const tg = new TelegramFeedback({});
  await assert.rejects(() => tg.deliver({ message: 'hi' }));
});

test('TelegramFeedback.deliver posts to the Telegram sendMessage endpoint', async () => {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  const now = () => new Date('2026-09-12T18:42:00.000Z');
  const tg = new TelegramFeedback({ botToken: 'tok', chatId: '42', fetchImpl, now });
  const entry = { message: 'Test feedback', page: '/rival' };
  await tg.deliver(entry);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bottok\/sendMessage/);
  assert.equal(calls[0].body.chat_id, '42');
  assert.ok(calls[0].body.text.includes('Test feedback'));
  assert.equal(calls[0].body.disable_web_page_preview, true);
});

test('TelegramFeedback.deliver throws on a non-OK response', async () => {
  const fetchImpl = () => ({ ok: false, status: 401 });
  const tg = new TelegramFeedback({ botToken: 'bad', chatId: '1', fetchImpl });
  await assert.rejects(() => tg.deliver({ message: 'hi' }), { message: /401/ });
});

test('FeedbackSpill persists entries to disk and loads them on construction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'spill.json');
  const now = () => new Date('2026-01-01T00:00:00.000Z');

  const first = new FeedbackSpill({ filePath, now });
  const entry = await first.add({ message: 'queued', page: '/game' });
  assert.ok(entry.id);
  assert.equal(entry.message, 'queued');
  const raw = await readFile(filePath, 'utf8');
  assert.ok(raw.includes('queued'));

  const second = new FeedbackSpill({ filePath, now });
  await second.drain(async () => { throw new Error('keep'); });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, entry.id);
});

test('FeedbackSpill.remove deletes an entry by id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-remove-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'spill.json');
  const spill = new FeedbackSpill({ filePath, now: () => new Date('2026-01-01T00:00:00.000Z') });
  const entry = await spill.add({ message: 'to remove' });
  assert.equal(spill.entries.length, 1);
  await spill.remove(entry);
  assert.equal(spill.entries.length, 0);
});

test('FeedbackSpill.drain retries entries that fail and keeps those that succeed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const a = await spill.add({ message: 'a' });
  const b = await spill.add({ message: 'b' });
  const c = await spill.add({ message: 'c' });

  let callCount = 0;
  await spill.drain(async (entry) => {
    callCount += 1;
    if (entry.id === b.id) throw new Error('transient');
  });

  assert.equal(callCount, 3);
  assert.equal(spill.entries.length, 1);
  assert.equal(spill.entries[0].id, b.id);
  const raw = await readFile(spill.filePath, 'utf8');
  assert.doesNotMatch(raw, /"message":"a"/);
  assert.match(raw, /"message":"b"/);
});

test('FeedbackService.submit writes-ahead to spill, delivers successfully, and removes the entry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-service-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const calls = [];
  const deliverer = {
    enabled: true,
    deliver: async (entry) => { calls.push(entry); },
  };
  const metrics = new Metrics();
  const service = new FeedbackService({ deliverer, spill, metrics, now: () => new Date('2026-01-01T00:00:00.000Z') });

  const result = await service.submit({ message: 'All good', page: '/host' });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, undefined);
  assert.equal(calls.length, 1);
  assert.equal(spill.entries.length, 0);
  assert.ok(metrics.render().includes('kaspa_feedback_total{outcome="delivered"}'));
});

test('FeedbackService.submit spills but still returns accepted when delivery fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-service-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const deliverer = {
    enabled: true,
    deliver: async () => { throw new Error('Telegram down'); },
  };
  const service = new FeedbackService({ deliverer, spill, logger: { error() {} } });

  const result = await service.submit({ message: 'Help' });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(spill.entries.length, 1);
});

test('FeedbackService.submit throws when Telegram is not configured', async () => {
  const deliverer = { enabled: false, deliver: async () => {} };
  const service = new FeedbackService({ deliverer, spill: new FeedbackSpill({}) });
  await assert.rejects(
    () => service.submit({ message: 'gone' }),
    { code: 'FEEDBACK_UNAVAILABLE' },
  );
});

test('FeedbackService.drainPending retries spilled entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  await spill.add({ message: 'drain me' });
  assert.equal(spill.entries.length, 1);

  const delivered = [];
  const deliverer = { enabled: true, deliver: async (entry) => { delivered.push(entry); } };
  const service = new FeedbackService({ deliverer, spill, logger: { info() {} } });
  await service.drainPending();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, 'drain me');
  assert.equal(spill.entries.length, 0);
});

test('feedback endpoint is unavailable when TELEGRAM env vars are missing', async (t) => {
  const port = 6100 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-feedback-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(directory, 'games.json'),
      GAME_FEE_ADDRESS: feeAddress,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'test' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'FEEDBACK_UNAVAILABLE');
});

test('feedback endpoint accepts valid submissions and persists them to disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-post-'));
  const spillPath = join(dir, 'spill.json');
  const port = 6400 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(dir, 'games.json'),
      GAME_FEE_ADDRESS: feeAddress,
      FEEDBACK_SPILL_PATH: spillPath,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy-token-for-test',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy-chat-id',
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Loved the game', page: '/rival', screen: '390x844', browser: 'Chrome 128' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);

  // Delivery fails (dummy token) so the entry should have been persisted.
  for (let i = 0; i < 10; i++) {
    try {
      const raw = await readFile(spillPath, 'utf8');
      const entries = JSON.parse(raw);
      if (entries.length > 0) {
        assert.ok(entries[0].message.includes('Loved the game'));
        return;
      }
    } catch {
      // File may not exist yet; the spill module writes after validation.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Expected a spilled entry to appear on disk');
});

test('feedback endpoint rejects empty messages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-empty-'));
  const port = 6700 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(dir, 'games.json'),
      FEEDBACK_SPILL_PATH: join(dir, 'spill.json'),
      GAME_FEE_ADDRESS: feeAddress,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy',
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'INVALID_FEEDBACK');
});

test('feedback endpoint enforces the per-client rate limit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-rate-'));
  const port = 7000 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(dir, 'games.json'),
      FEEDBACK_SPILL_PATH: join(dir, 'spill.json'),
      GAME_FEE_ADDRESS: feeAddress,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy',
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `msg ${i}` }),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 after the rate limit, saw ${statuses.join(',')}`);
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* child may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Local server did not start');
}
