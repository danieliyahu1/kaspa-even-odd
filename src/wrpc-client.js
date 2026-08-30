import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NETWORK, ProtocolError } from './protocol.js';

const require = createRequire(import.meta.url);
const sdkPath = fileURLToPath(new URL('../vendor/kaspa-wasm32-sdk/v2.0.1/nodejs/kaspa/kaspa.js', import.meta.url));
const kaspa = require(sdkPath);

export class WrpcClient {
  constructor({ network = NETWORK, url = process.env.KASPA_WRPC_URL } = {}) {
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
    const url = this.url ?? await new kaspa.Resolver().getUrl(kaspa.Encoding.Borsh, this.network);
    const rpc = new kaspa.RpcClient({ url, networkId: this.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 10_000, retryInterval: 1_000 });
    this.url = url;
    this.rpc = rpc;
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
