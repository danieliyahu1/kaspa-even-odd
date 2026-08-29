# Kaspa and SilverScript Research

Sources reviewed:

- Rusty Kaspa WASM SDK: https://github.com/kaspanet/rusty-kaspa/tree/master/wasm
- Kaspa JavaScript API reference: https://kaspa.aspectron.org/docs/
- Kaspa npm package: https://www.npmjs.com/package/kaspa
- SilverScript repository: https://github.com/kaspanet/silverscript
- SilverScript tutorial: https://github.com/kaspanet/silverscript/blob/master/docs/TUTORIAL.md
- SilverScript declarations and ABI: https://github.com/kaspanet/silverscript/blob/master/docs/DECL.md

## Decisions

- The application targets `testnet-10` and requires pinned Rusty Kaspa v2.0.1
  WASM for transaction-v1 covenant construction. The obsolete npm
  `kaspa-wasm@0.13.0` package predates this boundary and is not used.
- SilverScript is compiled outside the browser with `silverc`. The browser
  consumes a pinned artifact because SilverScript is experimental and has no
  stable official JavaScript compiler API.
- Invites are URL-only: `/join?v=EO%2Fv1&game=<64-hex-id>`. Open-game
  discovery is not part of this implementation.
- Secrets remain local to the wallet or browser storage and are not included
  in invite URLs or backend metadata.
- Game confirmation is authoritative: an invite is generated only after the
  injected chain adapter reports a confirmed creation transaction matching the
  prepared game identifier.

## Resolved External Contracts

The two previously-unresolved external boundaries are now pinned and enforced:

- **Official Rusty Kaspa v2.0.1 WASM release artifact checksum** — pinned
  (`wasmReleaseSha256 7eaffac9…67a71`) and vendored
  (`vendoredWasmFileSha256 9427733c…99eaa`); the vendored file is verified
  against the pin in `test/wasm-transaction.test.js`.
- **Fee-input selection and fee-rate policy** — live-priority estimate plus
  local v1 mass/relay floors, deterministic largest-first ordinary UTXO
  selection (covenant UTXOs excluded), in `src/fee-policy.js`, covered by
  `test/fee-policy.test.js` and `test/chain-adapter.test.js`.

The SilverScript compiler/source revision, ABI artifact, state layout, template
hash, source/artifact SHA-256 values, covenant P2SH derivation, genesis
covenant-ID construction, Kastle mutation policy, and confirmation/reorg
lifecycle are now implemented and covered by golden-vector, real-Rust-oracle
(`test/covenant-oracle-runtime.test.js`), or whole-flow integration tests.

The implementation rejects missing or mismatched covenant artifacts instead of
guessing these values.
