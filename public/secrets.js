// Browser-local reveal-secret storage for Even/Odd.
//
// Each game's hidden number is committed on-chain as blake2b256(choice_le64 ||
// nonce). The covenant (even_odd.sil `reveal`) re-derives that exact preimage,
// so the commitment format is fixed and must never be "domain separated" here.
// Secrecy comes entirely from the 32-byte nonce being unpredictable per game.
//
// Secrets are stored only in this browser's IndexedDB. There is no cloud
// backup and no server copy: clearing site data or switching browsers before
// reveal makes the locked stake unrecoverable through the normal interface.
import { blake2b256 } from '/src/hashes/blake2b.mjs';

const DB_NAME = 'kaspa-even-odd';
const STORE_NAME = 'reveal-secrets';
const SECRET_PREFIX = 's:';
const LINK_PREFIX = 'g:';

export function randomNonce() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable in this browser');
  return crypto.getRandomValues(new Uint8Array(32));
}

function randomId(bytes = 16) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeI64Fixed(value) {
  let remaining = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function revealPreimage(choice, nonce) {
  const out = new Uint8Array(40);
  out.set(encodeI64Fixed(choice), 0);
  out.set(nonce, 8);
  return out;
}

export function commitmentFor(choice, nonce) {
  if (choice !== 0 && choice !== 1) throw new Error('Choice must be 0 or 1');
  return bytesToHex(blake2b256(revealPreimage(choice, nonce)));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is unavailable in this browser'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function put(record) {
  const db = await openDb();
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
}

async function get(key) {
  const db = await openDb();
  return requestResult(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key));
}

// Generates a fresh secret, persists it, and returns only the opaque secretId
// and commitment. The nonce and choice never leave this function's caller and
// are only re-read at reveal. The await on put() guarantees the secret is
// durable before the wallet is ever asked to lock funds.
export async function createRevealSecret(choice) {
  if (choice !== 0 && choice !== 1) throw new Error('Choice must be 0 or 1');
  const nonce = randomNonce();
  const secretId = randomId();
  const record = { key: `${SECRET_PREFIX}${secretId}`, choice, nonceHex: bytesToHex(nonce), commitment: commitmentFor(choice, nonce) };
  await put(record);
  return { secretId, commitment: record.commitment };
}

export async function bindSecretToGame(gameId, secretId) {
  if (!gameId || !secretId) throw new Error('gameId and secretId are required');
  await put({ key: `${LINK_PREFIX}${gameId}`, secretId });
}

export async function loadSecretForGame(gameId) {
  const link = await get(`${LINK_PREFIX}${gameId}`);
  if (!link?.secretId) return null;
  const record = await get(`${SECRET_PREFIX}${link.secretId}`);
  if (!record) return null;
  return { choice: record.choice, nonceHex: record.nonceHex, commitment: record.commitment };
}

// Removes a game's reveal secret and its link once the nonce is public or no
// longer needed (settled, claimed, or refunded). Safe to call repeatedly.
export async function deleteSecretForGame(gameId) {
  if (!gameId) return;
  const link = await get(`${LINK_PREFIX}${gameId}`);
  const db = await openDb();
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  store.delete(`${LINK_PREFIX}${gameId}`);
  if (link?.secretId) store.delete(`${SECRET_PREFIX}${link.secretId}`);
  await new Promise((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error ?? new Error('IndexedDB delete failed'));
    store.transaction.onabort = () => reject(store.transaction.error ?? new Error('IndexedDB delete aborted'));
  });
}
