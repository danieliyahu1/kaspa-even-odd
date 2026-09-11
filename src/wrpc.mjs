// Kaspa wRPC client for the pinned v2.0.1 SDK, used by the backend to read the
// chain and broadcast transactions. The browser never talks to the node
// directly; all chain communication is server-side.
import { NETWORK, ProtocolError } from './protocol.js';
import { loadWasmSdk, initWasmSdk } from './wasm-loader.mjs';

const DEFAULT_NODE_URL = typeof process !== 'undefined' ? process?.env?.KASPA_WRPC_URL : undefined;

export class WrpcClient {
  constructor({ network = NETWORK, url = DEFAULT_NODE_URL } = {}) {
    if (network !== NETWORK) throw new ProtocolError('WRONG_NETWORK', `Expected ${NETWORK}`);
    this.network = network;
    this.url = url;
    this.rpc = null;
    this.connecting = null;
  }

  async connect() {
    if (this.rpc) return this;
    if (!this.connecting) this.connecting = this.#connect();
    try {
      await this.connecting;
      return this;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect() {
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.disconnect();
  }

  async getBlockDagInfo() {
    const response = await (await this.#rpc()).getBlockDagInfo();
    return response?.toJSON ? response.toJSON() : response;
  }

  async getUtxosByAddresses(addresses) {
    const response = await (await this.#rpc()).getUtxosByAddresses(addresses);
    const entries = (response?.entries ?? response).map(normalizeUtxoEntry);
    return { entries };
  }

  async getFeeEstimate() {
    const response = await (await this.#rpc()).getFeeEstimate();
    const priority = response?.estimate?.priorityBucket;
    return { estimate: { priorityBucket: Array.isArray(priority) ? priority : [priority].filter(Boolean) } };
  }

  async submitSafeJson(signedTxJson) {
    const kaspa = loadWasmSdk();
    let transaction;
    try {
      transaction = kaspa.Transaction.deserializeFromSafeJSON(signedTxJson);
    } catch {
      throw new ProtocolError('INVALID_TRANSACTION', 'Signed transaction is not valid Kaspa SafeJSON');
    }
    const response = await (await this.#rpc()).submitTransaction({ transaction, allowOrphan: false });
    return response?.transactionId ?? response?.txId ?? response;
  }

  async #rpc() {
    await this.connect();
    return this.rpc;
  }

  async #connect() {
    if (!loadWasmSdkSafe()) await initWasmSdk();
    const kaspa = loadWasmSdk();
    const url = this.url ?? await new kaspa.Resolver().getUrl(kaspa.Encoding.Borsh, this.network);
    const rpc = new kaspa.RpcClient({ url, networkId: this.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 10_000, retryInterval: 1_000 });
    this.url = url;
    this.rpc = rpc;
  }
}

function loadWasmSdkSafe() {
  try {
    return Boolean(loadWasmSdk());
  } catch {
    return false;
  }
}

export function normalizeUtxoEntry(entry) {
  const value = entry.entry ?? entry;
  return {
    ...value,
    outpoint: entry.outpoint ?? value.outpoint,
    amount: value.amount,
    scriptPublicKey: encodeScriptPublicKey(value.scriptPublicKey),
    blockDaaScore: value.blockDaaScore,
    isCoinbase: value.isCoinbase,
    covenantId: encodeCovenantId(value.covenantId),
  };
}

// The WASM UTXO entry exposes its covenant id as a `Hash` object with a hex
// `toString()` and no `toJSON()`, so it would serialize to `{}` (a map) inside
// a SafeJSON transaction. Normalize it to the hex string the SafeJSON expects.
function encodeCovenantId(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  return value.toString();
}

function encodeScriptPublicKey(value) {
  if (typeof value === 'string') return value;
  const version = Number(value?.version ?? 0).toString(16).padStart(4, '0');
  return `${version}${value?.script ?? ''}`;
}
