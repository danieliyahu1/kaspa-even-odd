// Pure-JS BLAKE2b-256 (used by Kaspa for P2SH / covenant-id hashing).
// Node's crypto only exposes BLAKE2b-512; BLAKE2b-256 is a distinct digest
// size (different initialisation parameter), so we implement it directly.

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const M64 = (1n << 64n) - 1n;
const M32 = 0xffffffffn;

function rotr64(x, n) {
  return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
}

function g(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & M64;
  v[d] = rotr64(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & M64;
  v[b] = rotr64(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & M64;
  v[d] = rotr64(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & M64;
  v[b] = rotr64(v[b] ^ v[c], 63);
}

function compress(h, m, t, f) {
  const v = new Array(16);
  for (let i = 0; i < 8; i++) v[i] = h[i];
  for (let i = 0; i < 8; i++) v[i + 8] = IV[i];
  v[12] = v[12] ^ (t & M32);
  v[13] = v[13] ^ (t >> 32n);
  if (f) {
    v[14] = v[14] ^ M64;
  }

  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) {
    h[i] = h[i] ^ v[i] ^ v[i + 8];
  }
}

export function blake2b256(input, key = undefined) {
  if (typeof input === 'string') input = new TextEncoder().encode(input);
  input = new Uint8Array(input);

  if (typeof key === 'string') key = new TextEncoder().encode(key);
  key = key === undefined ? new Uint8Array() : new Uint8Array(key);
  if (key.length > 64) throw new RangeError('BLAKE2b key must not exceed 64 bytes');

  const h = IV.slice();
  h[0] = h[0] ^ 0x01010000n ^ (BigInt(key.length) << 8n) ^ 32n;

  if (key.length > 0) {
    const keyedInput = new Uint8Array(128 + input.length);
    keyedInput.set(key);
    keyedInput.set(input, 128);
    input = keyedInput;
  }

  const blockLen = 128;
  const nBlocks = Math.floor(input.length / blockLen);
  let t = 0n;

  // The final block is the last chunk: the remainder if the input is not a
  // multiple of 128, otherwise the last full block. All earlier blocks are
  // non-final.
  const rem = input.slice(nBlocks * blockLen);
  const lastFullIdx = rem.length === 0 ? nBlocks - 1 : -1;

  for (let i = 0; i < nBlocks; i++) {
    const block = input.slice(i * blockLen, (i + 1) * blockLen);
    const m = new Array(16).fill(0n);
    for (let w = 0; w < 16; w++) {
      let word = 0n;
      for (let k = 0; k < 8; k++) {
        word |= BigInt(block[w * 8 + k]) << BigInt(k * 8);
      }
      m[w] = word;
    }
    t += 128n;
    compress(h, m, t, i === lastFullIdx);
  }

  const m = new Array(16).fill(0n);
  if (rem.length > 0) {
    for (let w = 0; w < 16; w++) {
      let word = 0n;
      for (let k = 0; k < 8; k++) {
        const idx = w * 8 + k;
        if (idx < rem.length) word |= BigInt(rem[idx]) << BigInt(k * 8);
      }
      m[w] = word;
    }
    t += BigInt(rem.length);
    compress(h, m, t, true);
  }

  const out = new Uint8Array(32);
  let o = 0;
  outer: for (let i = 0; i < 8; i++) {
    const word = h[i];
    for (let k = 0; k < 8; k++) {
      if (o >= 32) break outer;
      out[o++] = Number((word >> BigInt(k * 8)) & 0xffn);
    }
  }
  return out;
}
