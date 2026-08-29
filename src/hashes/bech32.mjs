// Kaspa address encoding: classic bech32 (from kaspa-addresses bech32.rs).
// Layout: <prefix>:<bech32( [version_byte] ++ payload )>

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const GEN = [0x98f2bc8e61, 0x79b76d99e2, 0xf33e5fb3c4, 0xae2eabe2a8, 0x1e4f43e470];

function polymod(codes) {
  let c = 1n;
  for (const d of codes) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if ((c0 & (1n << BigInt(i))) !== 0n) c ^= BigInt(GEN[i]);
    }
  }
  return c ^ 1n;
}

function checksum(prefix5, payload5) {
  const codes = [];
  for (const p of prefix5) codes.push(p);
  codes.push(0);
  for (const p of payload5) codes.push(p);
  for (let i = 0; i < 8; i++) codes.push(0);
  return polymod(codes);
}

function conv8to5(payload) {
  const padding = payload.length % 5 === 0 ? 0 : 1;
  const fiveBit = new Array(Math.floor((payload.length * 8) / 5) + padding).fill(0);
  let buff = 0;
  let bits = 0;
  let currentIdx = 0;
  for (const c of payload) {
    buff = (buff << 8) | c;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      fiveBit[currentIdx] = (buff >> bits) & 0x1f;
      buff &= (1 << bits) - 1;
      currentIdx += 1;
    }
  }
  if (bits > 0) {
    fiveBit[currentIdx] = (buff << (5 - bits)) & 0x1f;
  }
  return fiveBit;
}

function conv5to8(payload) {
  const eightBit = new Array(Math.floor((payload.length * 5) / 8)).fill(0);
  let buff = 0;
  let bits = 0;
  let currentIdx = 0;
  for (const c of payload) {
    buff = (buff << 5) | c;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      eightBit[currentIdx] = (buff >> bits) & 0xff;
      buff &= (1 << bits) - 1;
      currentIdx += 1;
    }
  }
  return eightBit;
}

const prefix5 = (prefix) => Array.from(new TextEncoder().encode(prefix)).map((c) => c & 0x1f);

export function bech32Encode(prefix, version, payload) {
  const fivebitPayload = conv8to5([version, ...payload]);
  const sum = checksum(prefix5(prefix), fivebitPayload);
  const checksumBytes = toBeBytes(sum, 8);
  const checksum5 = conv8to5(checksumBytes.slice(3));
  const all = [...fivebitPayload, ...checksum5];
  return prefix + ':' + all.map((c) => CHARSET[c]).join('');
}

export function bech32Decode(encoded) {
  const sep = encoded.lastIndexOf(':');
  if (sep < 1) throw new Error('Invalid address (no separator)');
  const prefix = encoded.slice(0, sep);
  const dataPart = encoded.slice(sep + 1);
  const data5 = Array.from(dataPart).map((ch) => {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error('Invalid address character');
    return v;
  });
  if (data5.length < 8) throw new Error('Invalid address (too short)');
  const payload5 = data5.slice(0, data5.length - 8);
  const checksum5 = data5.slice(data5.length - 8);
  const sum = checksum(prefix5(prefix), payload5);
  const expectedChecksumBytes = toBeBytes(sum, 8).slice(3);
  const actualChecksumBytes = conv5to8(checksum5);
  if (expectedChecksumBytes.length !== actualChecksumBytes.length ||
      expectedChecksumBytes.some((b, i) => b !== actualChecksumBytes[i])) {
    throw new Error('Bad checksum');
  }
  const bytes = conv5to8(payload5);
  const version = bytes[0];
  return { prefix, version, payload: Uint8Array.from(bytes.slice(1)) };
}

function toBeBytes(valueBig, len) {
  const out = new Uint8Array(len);
  let v = valueBig;
  for (let i = 0; i < len; i++) {
    out[len - 1 - i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
