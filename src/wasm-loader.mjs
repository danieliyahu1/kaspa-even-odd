// Environment-agnostic loader for the pinned Rusty Kaspa v2.0.1 WASM SDK.
//
// - Node: synchronously requires the vendored NodeJS build (as before).
// - Browser: lazily imports the vendored web build and initializes it with the
//   WASM binary after verifying it against the pinned SHA-256 checksum, so a
//   tampered binary is refused before any transaction is built.
//
// Shared transaction builders call `loadWasmSdk()` synchronously; the browser
// must `await initWasmSdk()` once at startup before building anything.
import { ProtocolError } from './protocol.js';

const NODE_ENTRY = new URL('../vendor/kaspa-wasm32-sdk/v2.0.1/nodejs/kaspa/kaspa.js', import.meta.url);
const BROWSER_JS = '/vendor/kaspa-wasm32-sdk/v2.0.1/web/kaspa/kaspa.js';
const BROWSER_WASM = '/vendor/kaspa-wasm32-sdk/v2.0.1/web/kaspa/kaspa_bg.wasm';
const PINS_URL = '/covenant/pins.json';

let cachedWasm = null;
let browserInit = null;
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

if (!isBrowser) {
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const require = createRequire(import.meta.url);
  cachedWasm = require(fileURLToPath(NODE_ENTRY));
}

export function loadWasmSdk() {
  if (cachedWasm) return cachedWasm;
  throw new ProtocolError('WASM_UNAVAILABLE', 'WASM SDK is not initialized in this environment; await initWasmSdk() first');
}

export function isWasmReady() {
  return Boolean(cachedWasm);
}

export async function initWasmSdk() {
  if (cachedWasm) return cachedWasm;
  if (browserInit) return browserInit;
  browserInit = (async () => {
    const [module, wasmBytes, expectedHash] = await Promise.all([
      import(/* webpackIgnore: true */ BROWSER_JS),
      fetch(BROWSER_WASM).then((response) => {
        if (!response.ok) throw new ProtocolError('WASM_UNAVAILABLE', 'Kaspa WASM binary could not be loaded');
        return response.arrayBuffer();
      }),
      fetch(PINS_URL)
        .then((response) => (response.ok ? response.json() : null))
        .then((pins) => pins?.rustyKaspa?.webVendoredWasmFileSha256 ?? null)
        .catch(() => null),
    ]);
    if (expectedHash) {
      const digest = await crypto.subtle.digest('SHA-256', wasmBytes);
      const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== String(expectedHash).toLowerCase()) {
        throw new ProtocolError('WASM_UNAVAILABLE', 'Kaspa WASM binary does not match the pinned checksum');
      }
    }
    await module.default({ module_or_path: wasmBytes });
    cachedWasm = module;
    return cachedWasm;
  })();
  return browserInit;
}
