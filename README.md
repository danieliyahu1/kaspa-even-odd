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
  KasWare, checkpoints the non-secret lifecycle for recovery, and shares the
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
- `src/recovery.js` reconstructs game state from accepted chain history with a
  one-confirmation buffer, invalidates removed-block checkpoints, classifies
  external transactions, and provides memory and durable JSON recovery stores.
- `src/backend-game-service.js` exposes the browser boundary for live creation:
  it derives deadlines from testnet-10 DAA state, prepares from live UTXOs and
  fees, verifies KasWare SafeJSON, submits over wRPC, and checks confirmation.
- `src/backend-game-store.js` persists non-secret preparation and game metadata
  on disk. The browser does not create identities or simulate game state.
- `src/wasm-transaction.js` loads the pinned WASM SDK (`Transaction`,
  `GenesisCovenantGroup`, `populateGenesisCovenants`, `serializeToSafeJSON`)
  and rejects any wallet mutation of sighash-relevant fields.
- `src/genesis-transaction.js` computes the Rusty Kaspa v2 covenant ID,
  constructs output zero, proves exact fee separation, and rejects any wallet
  SafeJSON mutation outside input signature scripts.
- The Rust `covenant-oracle` (`oracle/`, built from the pinned rusty-kaspa
  v2.0.1 rev `a41a333b…`) is a real-runtime regression oracle for the P2SH-256
  script, `kaspatest:` address, state span, template hash, and genesis covenant
  id (see `test/covenant-oracle-runtime.test.js`). It depends on the vendored
  `silverscript` submodule (`silverscript-abi` by path) without modifying
  upstream code.

## Pinned Even/Odd covenant (testnet-10)

The canonical testnet covenant artifact is compiled by the `silverc` binary
from SilverScript `v1.0.0` (whose emitted artifact/compiler identifier remains
`0.1.0`) from `covenant/even_odd.sil` into
`covenant/even_odd.template.artifact.json`:

- **contract**: `EvenOdd`, template hash `8c8d50e0…98249`
- **state span**: `offset 1, len 219` (11 fields: `creator_hash`,
  `joiner_hash`, `creator_commit`, `joiner_commit`, `pot`, `deadline_daa`,
  `creator_even`, `creator_choice`, `joiner_choice`, `first_revealer_hash`,
  `status`)
- **dispatch tags**: `join = b1d2ce8f`, `refund = 762ffa55`
- **terminal dispatch tags**: `reveal = be6bd383`, `fallback_claim = 786ae157`,
  `refund_player = 7e21ac29`
- **P2SH-256**: `0xaa 0x20 <blake2b-256(redeemScript)>`; address prefix
  `kaspatest`, version byte 8.
- **reproducibility manifest**: `covenant/pins.json` pins the SilverScript
  release, source commit, emitted compiler version, plus source, artifact, and
  local Windows compiler SHA-256 values.

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
`v1.0.0`). The `covenant-oracle-runtime` tests need its `silverscript-abi`
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

`git push` to `main` is the deploy button. CI builds the `linux/arm64` image,
smoke-tests the published artifact against `/readyz` and `/metrics`, pushes the
immutable `sha-<commit>` tag to GHCR, and commits the exact published digest
into `deploy/deployment.yaml` (`deploy: sha-<commit>`), preserving the source
commit in the `kaspa-even-odd/source-revision` annotation. The generated commit
touches only `deploy/deployment.yaml`, which is excluded from the workflow
trigger, so the delivery flow terminates without recursing. Argo CD syncs the
cluster to Git — `prune` + `selfHeal` keep Git authoritative — so the pod rolls
to the new digest automatically. CI never talks to Kubernetes and holds no
cluster credential; there is no second deploy path.

Pull requests run the full validation plus an ARM64 image build (without
publishing). Several pushes in quick succession cancel obsolete in-flight
builds so the newest revision wins, and CI refuses to advance the manifest if a
newer source push has already landed on `main`.

Local verification mirrors the CI gate:

```sh
npm run check
npm test
docker build --platform linux/arm64 -t ghcr.io/danieliyahu1/kaspa-even-odd/kaspa-even-odd:sha-<git-sha> .
```

`deploy/deployment.yaml` pins the immutable image for the current release; the
image line is updated by CI, never by hand. Deleting a file under `deploy/`
removes the corresponding object from the cluster (Argo prunes it).

The optional `scripts/manual-smoke.mjs` live test signs and broadcasts a real
testnet-10 transaction. It commits no wallet material; supply a throwaway
testnet wallet through the environment:

```sh
EO_CREATOR_ADDRESS=... EO_CREATOR_PUBLIC_KEY=... EO_CREATOR_PRIVATE_KEY=... node scripts/manual-smoke.mjs --dry-run
```

Runtime details:

- Namespace: `kaspa-even-odd`
- Public port: `3000`; internal metrics port: `9464`
- Readiness endpoint: `/readyz` (returns 503 unless the state volume is both
  readable and writable and the store parses as valid JSON)
- Liveness endpoint: `/healthz` (process liveness only)
- Required runtime secrets: none. No ExternalSecret is needed; the `oci-vault`
  `ClusterSecretStore` contract is unused because the app has no server-side
  secret. Wallet keys never leave the browser.
- Required network: `KASPA_NETWORK=testnet-10` (the process fails closed for
  any other value); `KASPA_WRPC_URL` can pin a testnet-10 wRPC node.
- Required persistent storage: the `kaspa-even-odd-state` PVC mounted at
  `/var/lib/kaspa-even-odd` stores non-secret backend game metadata. It is
  `ReadWriteOnce` and only ever mounted by a single replica; the Deployment uses
  `strategy: Recreate` for that reason.
- Request controls: `MAX_REQUEST_BYTES` (default 1,000,000) caps request bodies,
  and `RATE_LIMIT_PER_MINUTE` (default 300) caps mutating API calls per client.
  Set `TRUST_PROXY=true` only behind a trusted proxy that rewrites
  `x-forwarded-for`. The in-memory relay expires entries after 10 minutes and
  caps payloads and entry count; reveal preparations are held in memory with a
  TTL instead of being written to the PVC.
- Logging: `LOG_LEVEL` (default `info`; `debug` adds static-asset requests) and
  `LOG_FORMAT` (`text` or `json`). Each request logs its method, route template,
  status, duration, and any protocol error code/message. Logs never contain
  request bodies, wallet addresses, keys, nonces, signatures, or transaction
  ids. In the browser, add `?debug=1` (or set `localStorage['kaspa-debug'] = '1'`)
  for verbose `[even-odd]` console tracing of the wallet flow; warnings and
  errors are always printed.

Observability:

- The serving process exposes Prometheus metrics on `9464` at `/metrics`
  (requests, errors, latency, wRPC calls, store operations, matchmaking
  backlog, relay entries, process memory). The public Service does not expose
  this port.
- `deploy/metrics-service.yaml` and `deploy/vmservicescrape.yaml` register the
  scrape target with the VictoriaMetrics operator.
- `deploy/grafana-dashboard.yaml` provisions the "Kaspa Even/Odd" dashboard
  into the `observability` namespace via the `grafana_dashboard: "1"` label.

## Trustless client

The friend/invite flow runs entirely in the browser and does not depend on the
backend to move funds:

- `src/wasm-loader.mjs` loads the pinned Rusty Kaspa v2.0.1 SDK in Node (NodeJS
  build) or the browser (web build), verifying the WASM binary against the
  pinned SHA-256 before use.
- `src/covenant/even-odd-core.mjs` is the isomorphic, `Buffer`-free covenant
  derivation; `src/covenant/template.mjs` supplies the pinned artifact.
- `src/client-actions.mjs` builds create/join/reveal/refund/claim transactions
  locally; `src/wrpc.mjs` is the isomorphic wRPC client used to read UTXOs/DAA
  and broadcast.
- `public/game-client.js` orchestrates build → sign (KasWare) → broadcast,
  persists non-secret game metadata in IndexedDB, and re-verifies any relayed
  opponent data on-chain before use.
- `public/secrets.js` stores each game's hidden number in IndexedDB using a
  fresh 32-byte `crypto.getRandomValues` nonce (saved before funds are locked).
- `public/verify.js` independently re-derives the covenant and checks the
  prepared creation output before KasWare is asked to sign.

The invite URL (`/join?v=…&game=…&pk=…&c=…&s=…&k=…&d=…&a=…`) carries the full
non-secret creation state so a joiner can rebuild the covenant without the
server. An optional untrusted relay (`POST/GET /api/relay/:gameId`) lets the
opponent discover the join; every relayed payload is re-derived and checked
against the on-chain covenant before it is trusted. If the relay or backend is
unavailable, the on-chain DAA timeouts still let players reveal, claim, or
refund from a compatible client.

The "Find a rival" matchmaking flow is still server-mediated (pairing is a
server concern); the game itself remains enforced by the covenant.

## Support

If you like this repo, you can tip me at [https://kas.coffee/danieliyahu](https://kas.coffee/danieliyahu).
