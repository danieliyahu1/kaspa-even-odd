import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { blake2b256 } from '../src/hashes/blake2b.mjs';
import { bech32Encode, bech32Decode } from '../src/hashes/bech32.mjs';
import {
  EVEN_ODD_TEMPLATE,
  deriveGameInstance,
  verifyTemplateHash,
  parseCovenantAddress,
} from '../src/covenant/even-odd.mjs';

test('blake2b-256 single block matches published vector', () => {
  // abc -> published BLAKE2b-256 digest
  assert.equal(
    Buffer.from(blake2b256(new TextEncoder().encode('abc'))).toString('hex'),
    'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319'
  );
});

test('blake2b-256 multi-block matches the covenant-oracle digest', () => {
  // Cross-validated against the Rust covenant-oracle (blake2b_simd hash_length(32))
  // over the exact 1417-byte Even/Odd instance with creator_pk=0x07*32,
  // creator_commit=0x09*32, pot=100000000, deadline_daa=500000000000.
  const creatorPubkey = new Array(32).fill(7);
  const creatorCommit = new Array(32).fill(9);
  const inst = deriveGameInstance({ creatorPubkey, creatorCommit, potSompi: 100000000n, deadlineDaa: 500000000000n });
  assert.equal(inst.redeemScript.length, 1417);
  assert.equal(
    Buffer.from(blake2b256(Uint8Array.from(inst.redeemScript))).toString('hex'),
    '68ea319b16cc6356bfc43a2fcb131839fba81b35187eb6843711fd2b0a0dfd50'
  );
});

test('bech32 encode matches kaspa-addresses golden vectors', () => {
  // Address::new(Testnet, PubKey, &[0u8;32])
  assert.equal(
    bech32Encode('kaspatest', 0, new Uint8Array(32).fill(0)),
    'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya'
  );
  // Address::new(B, ScriptHash, b"abc")
  assert.equal(
    bech32Encode('b', 8, new TextEncoder().encode('abc')),
    'b:ppskycc8txxxn2w'
  );
  // Address::new(Testnet, PubKeyECDSA, &[0u8;33])
  assert.equal(
    bech32Encode('kaspatest', 1, new Uint8Array(33).fill(0)),
    'kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d'
  );
});

test('bech32 decode round-trips and rejects a corrupt checksum', () => {
  const addr = 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya';
  const d = bech32Decode(addr);
  assert.equal(d.prefix, 'kaspatest');
  assert.equal(d.version, 0);
  assert.equal(d.payload.length, 32);
  assert.equal(bech32Encode(d.prefix, d.version, d.payload), addr);
  assert.throws(() => bech32Decode(addr.slice(0, -2) + 'qq'));
});

test('pinned template hash verifies against the compiled artifact', () => {
  const v = verifyTemplateHash();
  assert.equal(v.computed, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(v.computed, '8c8d50e08d1b2c87391c907b8e2a3d13f568aa782eee92665bd38e42e9808249');
  assert.equal(v.prefixLen, 1);
  assert.equal(v.suffixLen, 1197);
  assert.equal(v.state.length, 219);
});

test('reproducibility manifest matches covenant source and artifact bytes', () => {
  const pins = JSON.parse(readFileSync(new URL('../covenant/pins.json', import.meta.url), 'utf8'));
  assert.equal(sha256('../covenant/even_odd.sil'), pins.covenant.sourceSha256);
  assert.equal(sha256('../covenant/even_odd.template.artifact.json'), pins.covenant.artifactSha256);
  assert.equal(pins.covenant.templateHash, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(pins.rustyKaspa.wasmReleaseSha256, '7eaffac9cd920ef2fdf540c6e10f2a2b7761170ebc62ec57dfa0f71c64567a71');
  assert.equal(pins.rustyKaspa.status, 'pinned');
});

test('per-game instance matches the covenant-oracle P2SH address', () => {
  const creatorPubkey = new Array(32).fill(7);
  const creatorCommit = new Array(32).fill(9);
  const inst = deriveGameInstance({ creatorPubkey, creatorCommit, potSompi: 100000000n, deadlineDaa: 500000000000n });
  // Governed by the Rust covenant-oracle: encode_runtime_state_script + script_parts
  // + Address::new(Testnet, ScriptHash, blake2b256(instance)).
  assert.equal(inst.address, 'kaspatest:pp5w5vvmzmxxx44lcsazljcnrqulh2qmx5v8ad5yxugl62c2ph74qckcujpkf');
  assert.equal(
    inst.p2shScript.toString('hex'),
    'aa2068ea319b16cc6356bfc43a2fcb131839fba81b35187eb6843711fd2b0a0dfd5087'
  );
  assert.equal(inst.templateHash, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(inst.address.startsWith('kaspatest:'), true);
  assert.equal(parseCovenantAddress(inst.address).version, 8);
});

test('different game state produces a different covenant address', () => {
  const a = deriveGameInstance({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), potSompi: 100000000n, deadlineDaa: 500000000000n });
  const b = deriveGameInstance({ creatorPubkey: new Array(32).fill(8), creatorCommit: new Array(32).fill(9), potSompi: 100000000n, deadlineDaa: 500000000000n });
  assert.notEqual(a.address, b.address);
});

test('rejects invalid game state', () => {
  assert.throws(() => deriveGameInstance({ creatorPubkey: [1, 2, 3], creatorCommit: new Array(32).fill(9), potSompi: 100000000n, deadlineDaa: 500000000000n }));
  assert.throws(() => deriveGameInstance({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), potSompi: -1n, deadlineDaa: 500000000000n }));
});

function sha256(relativePath) {
  return createHash('sha256').update(readFileSync(new URL(relativePath, import.meta.url))).digest('hex');
}
