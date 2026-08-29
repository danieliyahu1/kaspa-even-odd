const IV = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const MSG_SCHEDULE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
  [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
  [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
  [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
  [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
  [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) | 0;
}
function g(state, a, b, c, d, x, y) {
  state[a] = (state[a] + state[b] + x) | 0;
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rotr(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b] + y) | 0;
  state[d] = rotr(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rotr(state[b] ^ state[c], 7);
}
function round(state, msg, roundIdx) {
  const s = MSG_SCHEDULE[roundIdx];
  g(state, 0, 4, 8, 12, msg[s[0]], msg[s[1]]);
  g(state, 1, 5, 9, 13, msg[s[2]], msg[s[3]]);
  g(state, 2, 6, 10, 14, msg[s[4]], msg[s[5]]);
  g(state, 3, 7, 11, 15, msg[s[6]], msg[s[7]]);
  g(state, 0, 5, 10, 15, msg[s[8]], msg[s[9]]);
  g(state, 1, 6, 11, 12, msg[s[10]], msg[s[11]]);
  g(state, 2, 7, 8, 13, msg[s[12]], msg[s[13]]);
  g(state, 3, 4, 9, 14, msg[s[14]], msg[s[15]]);
}

function compress(cv, block, blockLen, counter, flags) {
  const state = new Array(16);
  for (let i = 0; i < 8; i++) state[i] = cv[i] | 0;
  state[8] = IV[0];
  state[9] = IV[1];
  state[10] = IV[2];
  state[11] = IV[3];
  state[12] = (counter & 0xffffffff) >>> 0;
  state[13] = (Math.floor(counter / 0x100000000) & 0xffffffff) >>> 0;
  state[14] = blockLen >>> 0;
  state[15] = flags >>> 0;
  for (let idx = 0; idx < 7; idx++) round(state, block, idx);
  for (let i = 0; i < 8; i++) {
    state[i] = (state[i] ^ state[i + 8]) >>> 0;
    state[i + 8] = (state[i + 8] ^ cv[i]) >>> 0;
  }
  return state;
}

function blockWords(block) {
  const words = new Array(16).fill(0);
  for (let i = 0; i < block.length; i++) {
    words[i >>> 2] = (words[i >>> 2] | (block[i] << ((i & 3) * 8))) >>> 0;
  }
  return words;
}

function compressInPlace(cv, blockWordsArr, blockLen, counter, flags) {
  const state = compress(cv, blockWordsArr, blockLen, counter, flags);
  for (let i = 0; i < 8; i++) cv[i] = state[i] >>> 0;
}

// Hash a single chunk: returns the input chaining value (before the final block),
// plus the final block words/len/flags needed for the ROOT compression.
function hashChunk(chunk, chunkCounter, key) {
  const nFull = Math.floor(chunk.length / BLOCK_LEN);
  const rem = chunk.length - nFull * BLOCK_LEN;
  const hasPartial = rem > 0;

  // Number of full blocks that precede the final block.
  const nPre = hasPartial ? nFull : Math.max(nFull - 1, 0);

  let cv = key ? key.slice() : IV.slice();
  for (let i = 0; i < nPre; i++) {
    const block = chunk.slice(i * BLOCK_LEN, (i + 1) * BLOCK_LEN);
    const blockFlags = i === 0 ? CHUNK_START : 0;
    compressInPlace(cv, blockWords(block), BLOCK_LEN, chunkCounter, blockFlags);
  }
  const preFinalCv = cv; // cv before the final block

  let finalWords;
  let finalLen;
  let blockFlags;
  if (hasPartial) {
    finalWords = blockWords(chunk.slice(nFull * BLOCK_LEN));
    finalLen = rem;
    blockFlags = (nFull === 0 ? CHUNK_START : 0) | CHUNK_END;
  } else {
    const startIdx = Math.max(nFull - 1, 0);
    finalWords = blockWords(chunk.slice(startIdx * BLOCK_LEN));
    finalLen = chunk.length === 0 ? 0 : BLOCK_LEN;
    blockFlags = (nFull <= 1 ? CHUNK_START : 0) | CHUNK_END;
  }
  return { cv: preFinalCv, finalWords, finalLen, blockFlags };
}

function blake3(input) {
  if (typeof input === 'string') input = new TextEncoder().encode(input);
  if (input.length <= CHUNK_LEN) {
    const { cv, finalWords, finalLen, blockFlags } = hashChunk(input, 0, null);
    const out = compress(cv, finalWords, finalLen, 0, blockFlags | ROOT);
    const outBytes = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const w = out[i] >>> 0;
      outBytes[i * 4] = w & 0xff;
      outBytes[i * 4 + 1] = (w >>> 8) & 0xff;
      outBytes[i * 4 + 2] = (w >>> 16) & 0xff;
      outBytes[i * 4 + 3] = (w >>> 24) & 0xff;
    }
    return outBytes;
  }
  throw new Error('blake3: inputs > 1024 bytes not implemented');
}

export { blake3, PARENT };
