import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendGameService } from './backend-game-service.js';
import { BackendGameStore } from './backend-game-store.js';
import { NETWORK, ProtocolError } from './protocol.js';
import { WrpcClient } from './wrpc-client.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const configuredNetwork = process.env.KASPA_NETWORK ?? NETWORK;
const startedAt = new Date().toISOString();
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
if (configuredNetwork !== NETWORK) throw new Error(`KASPA_NETWORK must be ${NETWORK}`);

const rpc = new WrpcClient({ network: configuredNetwork });
const gameService = new BackendGameService({
  rpc,
  store: new BackendGameStore(process.env.GAME_STORE_PATH ?? '.data/games.json'),
});

const server = createServer((req, res) => {
  void route(req, res).catch((error) => sendError(res, error));
});

async function route(req, res) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/healthz' || pathname === '/readyz') {
    return sendJson(res, 200, { ok: true, service: 'kaspa-even-odd', network: NETWORK, startedAt });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, await gameService.networkStatus());
  }
  if (req.method === 'POST' && pathname === '/api/games/prepare') {
    return sendJson(res, 200, await gameService.prepareCreation(await readJson(req)));
  }
  if (req.method === 'POST' && pathname === '/api/games/submit') {
    return sendJson(res, 202, await gameService.submitCreation(await readJson(req)));
  }
  if (req.method === 'POST' && pathname === '/api/matchmaking/join') {
    return sendJson(res, 200, await gameService.joinMatchmaking(await readJson(req)));
  }
  const matchStatus = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})$/i);
  const matchAction = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})\/(commit|leave)$/i);
  if (req.method === 'GET' && matchStatus) {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    return sendJson(res, 200, await gameService.matchmakingStatus(matchStatus[1], query.get('address')));
  }
  if (req.method === 'POST' && matchAction?.[2] === 'commit') {
    return sendJson(res, 200, await gameService.submitMatchVote(matchAction[1], await readJson(req)));
  }
  if (req.method === 'POST' && matchAction?.[2] === 'leave') {
    const body = await readJson(req);
    return sendJson(res, 200, await gameService.leaveMatchmaking(matchAction[1], body.address));
  }
  const gameMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})$/i);
  const joinMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/join\/(prepare|submit)$/i);
  const revealMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/reveal\/(prepare|submit)$/i);
  const actionMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/(creator_refund|fallback_claim|refund_player)\/(prepare|submit)$/i);
  if (req.method === 'POST' && joinMatch?.[2] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareJoin(joinMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && joinMatch?.[2] === 'submit') {
    return sendJson(res, 202, await gameService.submitJoin(joinMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && revealMatch?.[2] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareReveal(revealMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && revealMatch?.[2] === 'submit') {
    return sendJson(res, 202, await gameService.submitReveal(revealMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && actionMatch?.[3] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareSafetyAction(actionMatch[1], actionMatch[2], await readJson(req)));
  }
  if (req.method === 'POST' && actionMatch?.[3] === 'submit') {
    return sendJson(res, 202, await gameService.submitSafetyAction(actionMatch[1], actionMatch[2], await readJson(req)));
  }
  if (req.method === 'GET' && gameMatch) {
    return sendJson(res, 200, await gameService.readGame(gameMatch[1]));
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/host' || pathname === '/rival' || pathname === '/join' || pathname === '/game')) {
    return serveFile(publicRoot, 'index.html', res);
  }
  if (req.method === 'GET' && /^\/(app|styles)\.\w+$/.test(pathname)) {
    return serveFile(publicRoot, pathname.slice(1), res);
  }
  if (req.method === 'GET' && pathname === '/blake2b.mjs') {
    return serveFile(sourceRoot, 'hashes/blake2b.mjs', res);
  }
  return sendJson(res, 404, { error: 'not_found' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new ProtocolError('REQUEST_TOO_LARGE', 'Request body is too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new ProtocolError('INVALID_JSON', 'Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendError(res, error) {
  const code = error?.code ?? 'INTERNAL_ERROR';
  const clientError = error instanceof ProtocolError || ['INVALID_JSON', 'REQUEST_TOO_LARGE'].includes(code);
  const notFound = ['GAME_NOT_FOUND', 'PREPARATION_NOT_FOUND', 'MATCH_NOT_FOUND'].includes(code);
  if (!clientError) console.error(error);
  sendJson(res, notFound ? 404 : clientError ? 400 : 502, {
    error: code,
    message: clientError ? error.message : 'Kaspa testnet10 backend is unavailable',
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveFile(root, requestPath, res) {
  const safePath = normalize(requestPath).replace(/^([.][.][\\/])+/, '');
  try {
    const body = await readFile(join(root, safePath));
    res.writeHead(200, { 'content-type': contentTypes[extname(safePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

server.listen(port, '0.0.0.0');

function shutdown() {
  server.close(async (error) => {
    try { await rpc.disconnect(); } catch (disconnectError) { console.error(disconnectError); }
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
