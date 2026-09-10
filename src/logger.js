// Dependency-free leveled logger for operational debugging.
//
// Output is intentionally identity-free: field names that could carry wallet
// addresses, transaction ids, nonces, keys, signatures, or request bodies are
// redacted before they reach the stream. Callers pass explicit scalar fields;
// request bodies and raw URLs are never logged.
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const REDACTED_FIELD = /(address|nonce|key|signature|private|secret|txjson|preparedhash|commitment|body|ip)/i;
const MAX_VALUE_LENGTH = 200;

export function createLogger({
  level = process.env.LOG_LEVEL ?? 'info',
  format = process.env.LOG_FORMAT ?? 'text',
  stream = process.stderr,
  now = () => new Date(),
} = {}) {
  const normalizedLevel = String(level).toLowerCase();
  const threshold = LEVELS[normalizedLevel] ?? LEVELS.info;
  const normalizedFormat = format === 'json' ? 'json' : 'text';

  function emit(name, event, fields = {}) {
    if ((LEVELS[name] ?? LEVELS.info) < threshold) return;
    const timestamp = now().toISOString();
    const safe = sanitizeFields(fields);
    const line = normalizedFormat === 'json'
      ? JSON.stringify({ time: timestamp, level: name, event, ...safe })
      : renderText(timestamp, name, event, safe);
    stream.write(`${line}\n`);
  }

  return {
    level: normalizedLevel,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const logger = createLogger();

export function sanitizeFields(fields = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (REDACTED_FIELD.test(name)) {
      safe[name] = '<redacted>';
      continue;
    }
    safe[name] = sanitizeValue(value);
  }
  return safe;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}\u2026` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (value instanceof Error) return value.message;
  try {
    return sanitizeValue(JSON.stringify(value));
  } catch {
    return '<unserializable>';
  }
}

function renderText(timestamp, level, event, fields) {
  const parts = [timestamp, level.toUpperCase(), event];
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    if (value === '<redacted>') {
      parts.push(`${name}=<redacted>`);
      continue;
    }
    parts.push(`${name}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(' ');
}
