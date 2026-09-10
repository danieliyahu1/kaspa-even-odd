import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWasmGenesisSafeJson } from '../src/wasm-transaction.js';
import { prepareCreateGame } from '../src/create-game.js';
import { verifySignedCreationSafeJson } from '../src/genesis-transaction.js';
import { KaspaChainAdapter } from '../src/chain-adapter.js';
import { submitSignedTransaction, readAddressUtxos, KaspaCreationConfirmer } from '../src/kaspa-adapter.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WASM = join(ROOT, 'vendor', 'kaspa-wasm32-sdk', 'v2.0.1', 'nodejs', 'kaspa', 'kaspa.js');
const w = require(WASM);

const NETWORK = 'testnet-10';
// This is a local operator tool that signs a real testnet transaction. Wallet
// material is never committed; supply a throwaway testnet wallet through the
// environment. See README "Manual live smoke test".
const CREATOR_ADDR = process.env.EO_CREATOR_ADDRESS ?? '';
const CREATOR_PUB = process.env.EO_CREATOR_PUBLIC_KEY ?? '';
const PRIV = process.env.EO_CREATOR_PRIVATE_KEY ?? '';

// CLI: node scripts/manual-smoke.mjs --dry-run  (build+sign only) | (default) broadcast+confirm
const DRY = process.argv.includes('--dry-run');
const SIDE = process.argv.includes('--even') ? 'even' : 'odd';

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--stake') args.stake = Number(process.argv[i + 1]);
  if (process.argv[i] === '--commit') args.commit = process.argv[i + 1];
}
const stakeKas = args.stake ?? 1;

class WrpcRpcAdapter {
  constructor(rpc) {
    this.rpc = rpc;
  }
  async getUtxosByAddresses(addresses) {
    const res = await this.rpc.getUtxosByAddresses(addresses);
    const entries = (res?.entries ?? res).map((entry) => {
      const spk = entry.scriptPublicKey ?? entry.entry?.scriptPublicKey;
      const version = spk?.version ?? 0;
      const script = typeof spk === 'string' ? spk : spk?.script ?? '';
      return {
        ...entry,
        outpoint: entry.outpoint ?? entry.entry?.outpoint,
        amount: entry.amount ?? entry.entry?.amount,
        blockDaaScore: entry.blockDaaScore ?? entry.entry?.blockDaaScore,
        isCoinbase: entry.isCoinbase ?? entry.entry?.isCoinbase,
        scriptPublicKey: scriptToHex({ version, script }),
      };
    });
    return { entries };
  }
  async getFeeEstimate() {
    const res = await this.rpc.getFeeEstimate();
    const est = res?.estimate;
    const pb = est?.priorityBucket;
    return { estimate: { priorityBucket: Array.isArray(pb) ? pb : [pb].filter(Boolean) } };
  }
  async submitTransaction({ transaction, allowOrphan }) {
    const res = await this.rpc.submitTransaction({ transaction, allowOrphan });
    return res;
  }
  async getBlockDagInfo() {
    const res = await this.rpc.getBlockDagInfo();
    const j = res?.toJSON ? res.toJSON() : res;
    return j;
  }
}

async function connect() {
  const res = new w.Resolver();
  const url = await res.getUrl(w.Encoding.Borsh, NETWORK);
  const rpc = new w.RpcClient({ url, networkId: NETWORK, encoding: w.Encoding.Borsh });
  await rpc.connect({ timeoutDuration: 10000, retryInterval: 1000 });
  return { rpc, adapter: new WrpcRpcAdapter(rpc), url };
}

function scriptToHex({ version, script }) {
  const ver = (version & 0xffff).toString(16).padStart(4, '0');
  return ver + script;
}

function toVersionedHex(spk) {
  if (typeof spk === 'string') return spk.length === 66 ? spk : spk.padStart(66, '00');
  return spk?.version !== undefined ? scriptToHex(spk) : spk?.script ?? '';
}

function requireWallet() {
  const missing = [
    ['EO_CREATOR_ADDRESS', CREATOR_ADDR],
    ['EO_CREATOR_PUBLIC_KEY', CREATOR_PUB],
    ['EO_CREATOR_PRIVATE_KEY', PRIV],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

async function main() {
  requireWallet();
  const { adapter, url } = await connect();
  process.on('exit', () => { try { conn?.rpc?.disconnect?.(); } catch {} });
  let conn = { rpc: adapter.rpc, url };

  const request = prepareCreateGame({
    network: NETWORK,
    creatorAddress: CREATOR_ADDR,
    creatorPublicKey: CREATOR_PUB,
    creatorCommitment: args.commit ?? '09'.repeat(32),
    deadlineDaa: 556500000000n,
    side: SIDE,
    stakeKas,
    feeSompi: 0n,
  });

  const chain = new KaspaChainAdapter({
    rpc: adapter,
    covenantAddress: request.covenantAddress,
    scriptPublicKey: request.covenantScriptPublicKey,
    outputIndex: 0,
    confirmCreation: undefined,
  });

  const prepared = await chain.prepareCreation(request);
  console.log('=== PREPARED ===');
  console.log('side:', SIDE, 'stake:', stakeKas, 'KAS');
  console.log('covenantAddress:', request.covenantAddress);
  console.log('covenantScriptPublicKey:', request.covenantScriptPublicKey);
  console.log('covenantId:', prepared.covenantId);
  console.log('feeSompi:', prepared.feeSompi, 'mass:', prepared.mass);
  console.log('preparedHash:', prepared.preparedHash);
  console.log('txJson:', prepared.txJson);

  // sign the repo-prepared tx (now versioned SPK + compute budget 50 + SDK-mass
  // fee) directly, no post-processing
  const tx0 = w.Transaction.deserializeFromSafeJSON(prepared.txJson);
  tx0.finalize();
  const signed0 = w.signTransaction(tx0, [new w.PrivateKey(PRIV)], true);
  const signed0Json = signed0.serializeToSafeJSON();
  const txid0 = signed0.id;
  console.log('versionless txid:', txid0);

  // repo verification
  verifySignedCreationSafeJson({
    preparedTxJson: prepared.txJson,
    signedTxJson: signed0Json,
    request,
    policy: { ...prepared.policy, effectiveFeeSompi: prepared.feeSompi },
  });
  console.log('repo verification (versioned, compute budget 50): PASS');
  console.log('on-chain output SPK:', prepared.scriptPublicKey);
  console.log('consensus mass (WASM):', prepared.mass, 'feeSompi:', prepared.feeSompi.toString());

  const onChainCovenantId = JSON.parse(signed0Json).outputs[0]?.covenant?.covenantId;

  if (DRY) {
    console.log('DRY RUN — not broadcasting. evidence written to scripts/evidence-last.json');
    const { writeFileSync } = await import('node:fs');
    const txid = txid0;
    const versionedScriptPublicKey = prepared.scriptPublicKey;
    writeFileSync(join(__dirname, 'evidence-last.json'), JSON.stringify({
      dryRun: true, ...evidence(request, prepared, txid, signed0Json), onChainCovenantId,
      onChainScriptPublicKey: versionedScriptPublicKey, rpcUrl: url,
    }, null, 2));
    process.exit(0);
  }

  // broadcast over wRPC (on-chain tx is already versioned + budget 50)
  const id = await submitSignedTransaction({ rpc: adapter, transaction: signed0, allowOrphan: false });
  console.log('BROADCAST txid:', id);

  const confirmer = new KaspaCreationConfirmer({
    rpc: adapter,
    covenantAddress: request.covenantAddress,
    stakeSompi: request.stakeSompi,
    scriptPublicKey: prepared.scriptPublicKey,
    outputIndex: 0,
    attempts: 120,
    intervalMs: 3000,
  });
  const confirmation = await confirmer.confirmCreation({ transactionId: id });
  console.log('confirmation:', JSON.stringify(confirmation));

  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(__dirname, 'evidence-last.json'), JSON.stringify({
    ...evidence(request, prepared, id, signed0Json), onChainCovenantId,
    onChainScriptPublicKey: prepared.scriptPublicKey, rpcUrl: url, confirmation,
  }, null, 2));
  console.log('evidence written to scripts/evidence-last.json');
  try { await adapter.rpc.disconnect(); } catch {}
  process.exit(0);
}

function evidence(request, prepared, txid, signedJson) {
  return {
    network: NETWORK,
    protocolVersion: 'EO/v1',
    side: request.side,
    stakeSompi: request.stakeSompi.toString(),
    feeSompi: prepared.feeSompi.toString(),
    mass: prepared.mass,
    covenantAddress: request.covenantAddress,
    covenantScriptPublicKey: request.covenantScriptPublicKey,
    covenantRedeemScript: request.covenantRedeemScript,
    covenantTemplateHash: request.covenantTemplateHash,
    covenantId: prepared.covenantId,
    preparedHash: prepared.preparedHash,
    txid,
    signedSafeJson: signedJson,
    noSecrets: true,
    wasmSdk: 'kaspa-wasm32-sdk v2.0.1',
  };
}

main().catch((e) => {
  console.error('MANUAL SMOKE FAILED:', e?.code, e?.message || e);
  process.exit(1);
});
