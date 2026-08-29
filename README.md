# Kaspa Even/Odd

Initial protocol implementation for the non-custodial Even/Odd MVP on
Kaspa `testnet-10`.

The join flow is invite-only. A creator shares a URL containing only the
protocol version and confirmed game identifier. The URL never contains a
secret, commitment preimage, wallet key, or transaction template.

## Current boundary

- `src/protocol.js` validates sides, stake, sompi arithmetic, network, and
  fee separation.
- `src/invite.js` parses and serializes the URL invite.
- `src/create-game.js` validates the creation intent, requires a chain service
  to prepare and verify Rusty Kaspa v2 SafeJSON, delegates signing only to
  Kastle, checkpoints the non-secret lifecycle for recovery, and shares the
  confirmed transaction ID only after authoritative revalidation.
- `src/join-game.js` parses direct invites, re-reads confirmed game state,
  enforces the joining deadline and exact matching stake, and checkpoints the
  join signing, broadcast, confirmation, and recovery lifecycle.
- `src/join-transactions.js` builds the join covenant input and doubled-pot
  continuation with ordinary joiner fee inputs kept separate.
- `src/covenant-artifact.js` validates a pinned SilverScript artifact before
  it can be used. SilverScript compilation is intentionally a build-time
  concern; the browser consumes the resulting artifact.
- `src/covenant/even-odd.mjs` derives the per-game covenant instance: it loads
  the pinned artifact, substitutes the game state into the template state span,
  verifies the template hash, and produces the P2SH-256 script and `kaspatest:`
   address. Output is byte-for-byte cross-validated against the authoritative
   Rust `covenant-oracle` (see `oracle/`).
- `src/chain-adapter.js` provides the production `KaspaChainAdapter`:
  `prepareCreation` (UTXOs + live priority feerate + local mass/relay floor
  policy via `src/fee-policy.js`), WASM `verifySignedCreation`,
  `submitCreation` over wRPC, and `confirmCreation` gated on one DAA
  confirmation.
- `src/terminal-actions.js` reduces confirmed game state into fallback-claim and
  individual-refund eligibility, including DAA deadlines, race precedence, and
  fail-closed user-facing outcomes.
- `src/terminal-transactions.js` builds KCC entry scripts and Rusty Kaspa v2
  SafeJSON templates for reveal-adjacent terminal actions, claims, and refunds;
  the browser still signs only the prepared transaction.
- `src/terminal-lifecycle.js` provides the authoritative read, idempotent
  checkpoint, sign, submit, confirmation, and recovery lifecycle for terminal
  actions.
- `src/wasm-transaction.js` loads the pinned WASM SDK (`Transaction`,
  `GenesisCovenantGroup`, `populateGenesisCovenants`, `serializeToSafeJSON`)
  and rejects any Kastle mutation of sighash-relevant fields.
- `src/genesis-transaction.js` computes the Rusty Kaspa v2 covenant ID,
  constructs output zero, proves exact fee separation, and rejects any Kastle
  SafeJSON mutation outside input signature scripts.
- The Rust `covenant-oracle` (`oracle/`, built from the pinned rusty-kaspa
  v2.0.1 rev `a41a333b…`) is a real-runtime regression oracle for the P2SH-256
  script, `kaspatest:` address, state span, template hash, and genesis covenant
  id (see `test/covenant-oracle-runtime.test.js`). It depends on the vendored
  `silverscript` submodule (`silverscript-abi` by path) without modifying
  upstream code.

## Pinned Even/Odd covenant (testnet-10)

The canonical testnet covenant artifact is compiled by `silverc` 0.1.0 from
`covenant/even_odd.sil` into `covenant/even_odd.template.artifact.json`:

- **contract**: `EvenOdd`, template hash `49532e…f815`
- **state span**: `offset 1, len 219` (11 fields: `creator_hash`,
  `joiner_hash`, `creator_commit`, `joiner_commit`, `pot`, `deadline_daa`,
  `creator_even`, `creator_choice`, `joiner_choice`, `first_revealer_hash`,
  `status`)
- **dispatch tags**: `join = 51710335`, `refund = acb37330`
- **terminal dispatch tags**: `reveal = d693d4f5`, `fallback_claim = e4d7e9ea`,
  `refund_player = 28ba1e1d`
- **P2SH-256**: `0xaa 0x20 <blake2b-256(redeemScript)>`; address prefix
  `kaspatest`, version byte 8.
- **reproducibility manifest**: `covenant/pins.json` pins the SilverScript source
  commit plus source, artifact, and local Windows compiler SHA-256 values.

The ABI, state layout, compiler revision, covenant artifact, Rusty Kaspa v2.0.1
WASM release checksum, fee-input selection, and fee-rate policy are all pinned
before real funds are accepted. See `covenant/pins.json` (`rustyKaspa.status =
"pinned"`, `wasmReleaseSha256`, `vendoredWasmFileSha256`).
The obsolete npm `kaspa-wasm@0.13.0` package is intentionally not used for
covenant transaction construction.

## Verification

```sh
npm test
npm run check
```

`silverscript/` is a pinned git submodule (upstream `kaspanet/silverscript` at
`db9e1baf`). The `covenant-oracle-runtime` tests need its `silverscript-abi`
crate, so initialize the submodule and build the standalone oracle before
running them:

```sh
git submodule update --init
cd oracle && cargo build --release && cd ..
```

## Deployment

The repository includes a production container and Kubernetes manifests under
`deploy/`. The runtime process exposes Kubernetes probe endpoints only; the
protocol implementation remains the module exported by `src/index.js`.

```sh
npm run check
npm test
docker build --platform linux/arm64 -t ghcr.io/<owner>/<repo>/kaspa-even-odd:sha-<git-sha> .
kubectl apply -f deploy/namespace.yaml
kubectl apply -f deploy/deployment.yaml
kubectl apply -f deploy/service.yaml
```

Before applying `deploy/deployment.yaml`, replace
`ghcr.io/OWNER/REPOSITORY/kaspa-even-odd:REPLACE_WITH_IMMUTABLE_TAG` with an
immutable image tag, such as `ghcr.io/<owner>/<repo>/kaspa-even-odd:sha-<git-sha>`.

Runtime details:

- Namespace: `kaspa-even-odd`
- Port: `3000`
- Readiness endpoint: `/readyz`
- Liveness endpoint: `/healthz`
- Required runtime secrets: none
- Required persistent storage: none
