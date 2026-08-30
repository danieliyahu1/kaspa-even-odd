import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('server serves the browser application and health probe', async (t) => {
  const port = 3100 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  await waitForServer(`http://127.0.0.1:${port}/readyz`);
  const [page, health, missing, demoApi, appScript] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/healthz`),
    fetch(`http://127.0.0.1:${port}/public-game-list`),
    fetch(`http://127.0.0.1:${port}/api/demo/games`),
    fetch(`http://127.0.0.1:${port}/app.js`),
  ]);

  assert.equal(page.status, 200);
  assert.match(await page.text(), /Even\/Odd/);
  assert.deepEqual(await health.json().then(({ ok, service, network }) => ({ ok, service, network })), { ok: true, service: 'kaspa-even-odd', network: 'testnet-10' });
  assert.equal(missing.status, 404);
  assert.equal(demoApi.status, 404);
  const browserSource = await appScript.text();
  assert.doesNotMatch(browserSource, /api\/demo|eo-demo-player|Simulate timeout/);
  assert.match(browserSource, /api\/games\/prepare/);
  assert.doesNotMatch(browserSource, /one DAA confirmation/i);
  assert.match(browserSource, /Claim pot/);
  assert.match(browserSource, /Join for /);
  assert.match(browserSource, /data-reveal-number/);
  assert.match(browserSource, /That was the wrong number/);
  assert.match(browserSource, /INVALID_REVEAL/);
  assert.match(browserSource, /reveal-notice/);
  assert.doesNotMatch(browserSource, /showNotice\('#game-action'/);
  assert.match(browserSource, /data-commit-number/);
  assert.match(browserSource, /data-join-number/);
  assert.match(browserSource, /createRevealSecret\(number\)/);
  assert.doesNotMatch(browserSource, /createRevealSecret\(yourSide/);
  assert.match(browserSource, /Even \/ Odd|Even\/Odd/);
  assert.doesNotMatch(browserSource, /Guess even/i);
  assert.match(browserSource, /joinSection\(/);
  assert.doesNotMatch(browserSource, /renderJoin\(|Joining unavailable/);
  assert.doesNotMatch(browserSource, /data-action="create"/);
  assert.doesNotMatch(browserSource, /Refund my stake|Refund unmatched game/);
  assert.doesNotMatch(browserSource, /covenant|UTXO|commitment preimage|Player A side|\bPrepare with backend\b|\bCommit vote\b/i);
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child may need a moment to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Local server did not start');
}
