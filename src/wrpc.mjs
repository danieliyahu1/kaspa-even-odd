// Isomorphic Kaspa wRPC client for the pinned v2.0.1 SDK.
//
// Works in Node (via the NodeJS SDK build) and in the browser (via the web
// build over WebSocket). The backend keeps using this class; the browser uses
// it to read UTXOs/DAA and broadcast directly to a user-selectable node, so
// settlement does not depend on the app server.
import { NETWORK, ProtocolError } from './protocol.js';
import { loadWasmSdk, initWasmSdk } from './wasm-loader.mjs';

const DEFAULT_NODE_URL = typeof process !== 'undefined' ? process?.env?.KASPA_WRPC_URL : undefined;

// Browser-safe public testnet-10 wRPC WebSocket endpoint. The web SDK resolver
// returns `https://` (HTTP) endpoints that browsers block via CORS; a `wss://`
// URL uses the WebSocket transport, which is not CORS-gated.
export const DEFAULT_WRPC_URL = 'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh';

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
    covenantId: value.covenantId,
  };
}

function encodeScriptPublicKey(value) {
  if (typeof value === 'string') return value;
  const version = Number(value?.version ?? 0).toString(16).padStart(4, '0');
  return `${version}${value?.script ?? ''}`;
}
