import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('server serves the browser application and health probe', async (t) => {
  const port = 3100 + Math.floor(Math.random() * 500);
  const metricsPort = port + 600;
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-server-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(directory, 'games.json'),
      RATE_LIMIT_PER_MINUTE: '6',
      LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));

  await waitForServer(`http://127.0.0.1:${port}/readyz`);
  const [page, host, rival, health, missing, demoApi, appScript, gameClientScript, secretsScript, verifyScript, coreScript, genesisScript, artifact, pins, wasmJs, icon] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/host`),
    fetch(`http://127.0.0.1:${port}/rival`),
    fetch(`http://127.0.0.1:${port}/healthz`),
    fetch(`http://127.0.0.1:${port}/public-game-list`),
    fetch(`http://127.0.0.1:${port}/api/demo/games`),
    fetch(`http://127.0.0.1:${port}/app.js`),
    fetch(`http://127.0.0.1:${port}/game-client.js`),
    fetch(`http://127.0.0.1:${port}/secrets.js`),
    fetch(`http://127.0.0.1:${port}/verify.js`),
    fetch(`http://127.0.0.1:${port}/src/covenant/even-odd-core.mjs`),
    fetch(`http://127.0.0.1:${port}/src/genesis-transaction.js`),
    fetch(`http://127.0.0.1:${port}/covenant/even_odd.template.artifact.json`),
    fetch(`http://127.0.0.1:${port}/covenant/pins.json`),
    fetch(`http://127.0.0.1:${port}/vendor/kaspa-wasm32-sdk/v2.0.1/web/kaspa/kaspa.js`),
    fetch(`http://127.0.0.1:${port}/icon.svg`),
  ]);

  assert.equal(page.status, 200);
  assert.equal(host.status, 200);
  assert.equal(rival.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Even\/Odd/);
  assert.match(pageHtml, /Connect Wallet/);
  assert.match(pageHtml, /id="wallet-button"/);
  assert.deepEqual(await health.json().then(({ ok, service, network }) => ({ ok, service, network })), { ok: true, service: 'kaspa-even-odd', network: 'testnet-10' });
  assert.equal(missing.status, 404);
  assert.equal(demoApi.status, 404);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' https: wss: ws:/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const browserSource = await appScript.text();
  const gameClientSource = await gameClientScript.text();
  const secretsSource = await secretsScript.text();
  assert.equal(verifyScript.status, 200);
  assert.equal(coreScript.status, 200);
  assert.equal(genesisScript.status, 200);
  assert.equal(artifact.status, 200);
  assert.equal(pins.status, 200);
  assert.equal(wasmJs.status, 200);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.equal((await artifact.json()).contracts.EvenOdd.compiled.state_span.len, 219);
  assert.match(await pins.json().then((p) => p.rustyKaspa.webVendoredWasmFileSha256), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(browserSource, /api\/demo|eo-demo-player|Simulate timeout/);
  assert.match(browserSource, /api\/matchmaking\/\$\{match\.matchId\}\/creation/);
  assert.doesNotMatch(browserSource, /one DAA confirmation/i);
  assert.match(browserSource, /data-action="client-reveal"/);
  assert.match(browserSource, /Join for /);
  assert.doesNotMatch(browserSource, /data-reveal-number/);
  assert.doesNotMatch(browserSource, /FIXED_NONCE|fill\(1\)/);
  assert.match(gameClientSource, /loadSecretForGame/);
  assert.match(gameClientSource, /bindSecretToGame/);
  assert.doesNotMatch(browserSource, /showNotice\('#game-action'/);
  assert.match(browserSource, /data-commit-number/);
  assert.match(browserSource, /data-join-number/);
  assert.match(gameClientSource, /createRevealSecret\(number\)/);
  assert.doesNotMatch(browserSource, /createRevealSecret\(yourSide/);
  assert.match(browserSource, /Even \/ Odd|Even\/Odd/);
  assert.doesNotMatch(browserSource, /Guess even/i);
  assert.match(browserSource, /renderClientJoin\(/);
  assert.match(browserSource, /Find a rival/);
  assert.match(browserSource, /api\/matchmaking\/join/);
  assert.match(browserSource, /createGame\(\{ wallet/);
  assert.match(browserSource, /Play with a friend/);
  assert.match(browserSource, /location\.pathname === '\/host'/);
  assert.doesNotMatch(browserSource, /renderJoin\(|Joining unavailable/);
  assert.doesNotMatch(browserSource, /data-action="create"/);
  assert.match(browserSource, /Claim or refund/);
  assert.doesNotMatch(browserSource, /Refund unmatched game/);
  assert.doesNotMatch(browserSource, /UTXO|commitment preimage|Player A side|\bPrepare with backend\b|\bCommit vote\b/i);
  assert.match(secretsSource, /getRandomValues/);
  assert.match(secretsSource, /indexedDB/);
  assert.doesNotMatch(secretsSource, /fill\(1\)|FIXED_NONCE/);
  assert.match(browserSource, /joinGame\(\{ wallet/);
  assert.match(browserSource, /connectKasware/);
  assert.match(browserSource, /signPskt/);
  assert.match(browserSource, /deleteSecretForGame/);
  assert.match(browserSource, /forgetRevealSecret/);
  assert.match(secretsSource, /deleteSecretForGame/);
  assert.match(browserSource, /readRecoveryReadiness/);
  assert.match(browserSource, /data-recovery-wait/);
  assert.match(browserSource, /DEFAULT_WRPC_URL/);
  assert.match(browserSource, /recoveryControlState/);
  assert.match(browserSource, /initWalletButton/);
  assert.match(browserSource, /renderWalletButton/);
  assert.doesNotMatch(browserSource, /kastle/i);

  const wrpcSource = await (await fetch(`http://127.0.0.1:${port}/src/wrpc.mjs`)).text();
  assert.match(wrpcSource, /DEFAULT_WRPC_URL = 'wss:\/\/vector-10\.kaspa\.green\/kaspa\/testnet-10\/wrpc\/borsh'/);

  const modulePaths = [
    '/game-client.js',
    '/src/client-actions.mjs',
    '/src/wrpc.mjs',
    '/src/wasm-loader.mjs',
    '/src/funding.mjs',
    '/src/covenant/template.mjs',
    '/src/covenant/even-odd-core.mjs',
    '/src/terminal-transactions.js',
    '/src/join-transactions.js',
    '/src/reveal.js',
    '/src/wasm-transaction.js',
    '/src/fee-policy.js',
    '/src/kasware-wallet.js',
    '/src/hashes/blake2b.mjs',
    '/src/hashes/blake3.mjs',
    '/src/hashes/bech32.mjs',
    '/src/hashes/hex.mjs',
  ];
  for (const modulePath of modulePaths) {
    const response = await fetch(`http://127.0.0.1:${port}${modulePath}`);
    assert.equal(response.status, 200, `${modulePath} should be served`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
  }

  const origin = `http://127.0.0.1:${port}`;
  const seen = new Set();
  const queue = ['/app.js', '/secrets.js', '/verify.js', '/game-client.js'];
  while (queue.length) {
    const modulePath = queue.shift();
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    const response = await fetch(`${origin}${modulePath}`);
    assert.equal(response.status, 200, `${modulePath} should be reachable from the browser graph`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/, `${modulePath} should be JavaScript`);
    const source = await response.text();
    const specifiers = [
      ...[...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
      ...[...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:') || specifier.startsWith('http') || specifier.startsWith('data:')) continue;
      if (!specifier.startsWith('/') && !specifier.startsWith('.')) continue;
      queue.push(new URL(specifier, new URL(modulePath, origin)).pathname);
    }
  }
  assert.ok(seen.size >= 20, 'the browser module graph should include all client modules');

  const relayId = 'ab'.repeat(32);
  const relayPayload = { gameId: relayId, joiner: { publicKey: '08'.repeat(32) }, joinedAddress: 'kaspatest:x' };
  const relayPost = await fetch(`${origin}/api/relay/${relayId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(relayPayload),
  });
  assert.equal(relayPost.status, 200);
  const relayGet = await fetch(`${origin}/api/relay/${relayId}`);
  assert.deepEqual(await relayGet.json(), relayPayload);
  const relayMissing = await fetch(`${origin}/api/relay/${'cd'.repeat(32)}`);
  assert.equal(relayMissing.status, 404);

  const pageHeaders = await fetch(`${origin}/`);
  assert.equal(pageHeaders.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pageHeaders.headers.get('x-frame-options'), 'DENY');
  assert.equal(pageHeaders.headers.get('referrer-policy'), 'no-referrer');

  // Metrics live on a dedicated internal port and are never served publicly.
  const publicMetrics = await fetch(`${origin}/metrics`);
  assert.equal(publicMetrics.status, 404);
  const metricsOrigin = `http://127.0.0.1:${metricsPort}`;
  const metricsResponse = await fetch(`${metricsOrigin}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(metricsResponse.headers.get('content-type') ?? '', /text\/plain/);
  const metricsText = await metricsResponse.text();
  assert.match(metricsText, /kaspa_http_requests_total\{/);
  assert.match(metricsText, /kaspa_storage_operations_total\{operation="health"/);
  assert.match(metricsText, /kaspa_process_resident_memory_bytes/);
  assert.doesNotMatch(metricsText, /kaspatest:|[0-9a-f]{64}/);

  // Oversized relay payloads are rejected and the connection is not drained.
  const oversized = await fetch(`${origin}/api/relay/${'ef'.repeat(32)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: 'x'.repeat(300_000) }),
  }).catch(() => ({ status: 400 }));
  assert.equal(oversized.status, 400);

  // Mutating API calls are rate limited per client.
  const statuses = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${origin}/api/matchmaking/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 after the limit, saw ${statuses.join(',')}`);

  // Structured logs expose route templates and error codes, never identities.
  for (let attempt = 0; attempt < 50 && !/server_started/.test(stderr); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr, /server_started/);
  assert.match(stderr, /http_request/);
  assert.match(stderr, /route="\/api\/matchmaking\/join"/);
  assert.doesNotMatch(stderr, /kaspatest:|[0-9a-f]{64}/);
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
