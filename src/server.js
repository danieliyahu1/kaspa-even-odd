import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const startedAt = new Date().toISOString();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'kaspa-even-odd', startedAt }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0');

function shutdown(signal) {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
