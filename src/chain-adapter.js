import { ProtocolError } from './protocol.js';
import { readAddressUtxos, submitSignedTransaction, KaspaCreationConfirmer } from './kaspa-adapter.js';
import { estimateCreationFee, selectOrdinaryUtxos, CREATION_MASS_BOUND } from './fee-policy.js';
import { createWasmGenesisSafeJson, verifyWasmSignedSafeJson } from './wasm-transaction.js';

const DEFAULT_PRIORITY_BUCKET = 0;

export class KaspaChainAdapter {
  constructor({ rpc, covenantAddress, scriptPublicKey, outputIndex = 0, feeOptions, confidenceAttempts = 30, confidenceIntervalMs = 2_000, priorityBucket = DEFAULT_PRIORITY_BUCKET }) {
    if (!rpc) throw new ProtocolError('RPC_UNAVAILABLE', 'Kaspa RPC client is required');
    this.rpc = rpc;
    this.covenantAddress = covenantAddress;
    this.scriptPublicKey = scriptPublicKey;
    this.outputIndex = outputIndex;
    this.feeOptions = feeOptions;
    this.priorityBucket = priorityBucket;
    this.confidenceAttempts = confidenceAttempts;
    this.confidenceIntervalMs = confidenceIntervalMs;
  }

  async prepareCreation(request) {
    if (!request?.creatorAddress) throw new ProtocolError('INVALID_TRANSACTION', 'Creator address is required');
    if (typeof request?.covenantScriptPublicKey !== 'string' || request.covenantScriptPublicKey.length === 0) {
      throw new ProtocolError('INVALID_TRANSACTION', 'Covenant script public key is required');
    }
    const utxos = await readAddressUtxos({ rpc: this.rpc, addresses: [request.creatorAddress] });
    const entries = Array.isArray(utxos) ? utxos : utxos?.entries ?? [];

    const feerate = await this.#readPriorityFeerate();
    const funding = estimateFunding({ request, entries, feerate, feeOptions: this.feeOptions });
    const prepared = createWasmGenesisSafeJson({
      request,
      authorizingInput: 0,
      inputs: funding.inputs,
      change: funding.change,
      feerate,
      relayFloorRate: this.feeOptions?.relayFloorRate,
    });

    return Object.freeze({
      network: request.network,
      creatorAddress: request.creatorAddress,
      txJson: prepared.txJson,
      preparedHash: prepared.preparedHash,
      policy: { ...prepared.policy, effectiveFeeSompi: prepared.feeSompi },
      covenantId: prepared.covenantId,
      scriptPublicKey: parseScriptHex(prepared.txJson),
      feeSompi: prepared.feeSompi,
      mass: prepared.mass,
      feerate,
    });
  }

  async verifySignedCreation({ prepared, signedTxJson }) {
    verifyWasmSignedSafeJson({
      preparedTxJson: prepared.txJson,
      signedTxJson,
      policy: prepared.policy,
    });
    return { policy: prepared.policy };
  }

  async submitCreation(signedTransaction) {
    return submitSignedTransaction({ rpc: this.rpc, transaction: signedTransaction });
  }

  async confirmCreation({ transactionId, request, prepared }) {
    // The node reports UTXOs with the versioned output script, so match against
    // the versioned SPK the prepared tx actually carries.
    const scriptPublicKey = prepared?.scriptPublicKey ?? this.scriptPublicKey;
    const confirmer = new KaspaCreationConfirmer({
      rpc: this.rpc,
      covenantAddress: this.covenantAddress,
      stakeSompi: request.stakeSompi,
      scriptPublicKey,
      outputIndex: this.outputIndex,
      attempts: this.confidenceAttempts,
      intervalMs: this.confidenceIntervalMs,
    });
    return confirmer.confirmCreation({ transactionId });
  }

  async #readPriorityFeerate() {
    if (typeof this.rpc.getFeeEstimate !== 'function') return 0;
    const response = await this.rpc.getFeeEstimate();
    const buckets = response?.estimate?.priorityBucket ?? response?.estimate?.buckets ?? [];
    const bucket = buckets[this.priorityBucket];
    if (!bucket || typeof bucket.feerate !== 'number' || bucket.feerate < 0) return 0;
    return bucket.feerate;
  }
}

export function estimateFunding({ request, entries, feerate, feeOptions }) {
  const stakeSompi = request.stakeSompi;
  if (typeof stakeSompi !== 'bigint' || stakeSompi <= 0n) {
    throw new ProtocolError('INVALID_GAME_VALUE', 'Game stake must be positive sompi');
  }
  const committedFee = request.feeSompi;
  if (typeof committedFee !== 'bigint' || committedFee < 0n) {
    throw new ProtocolError('INVALID_FEE', 'Committed fee must be non-negative sompi');
  }

  const changeScriptPublicKey = feeOptions?.changeScriptPublicKey;
  const raw = entries.map(normalizeEntry);

  // Select fee inputs against a conservative mass upper bound so the chosen
  // UTXOs always cover the WASM-authoritative consensus mass the final tx
  // charges. The exact fee is recomputed from the SDK after building.
  const policyFee = estimateCreationFee({ mass: CREATION_MASS_BOUND, priorityFeerate: feerate, options: feeOptions }).feeSompi;
  const effectiveFee = policyFee > committedFee ? policyFee : committedFee;
  const target = stakeSompi + effectiveFee;

  const { selected, totalSompi } = selectOrdinaryUtxos({ utxos: entries, targetSompi: target });
  const fundingInputs = raw.filter((entry) => selected.some((s) => s.transactionId === entry.transactionId && s.index === entry.index));
  const changeValue = totalSompi - target;
  const change = changeValue > 0n
    ? { value: changeValue, scriptPublicKey: changeScriptPublicKey ?? fundingInputs[0].scriptPublicKey }
    : undefined;
  const mass = estimateMass(fundingInputs.length, change ? 2 : 1, fundingInputs);

  return {
    inputs: fundingInputs,
    change,
    feeSompi: effectiveFee,
    committedFee,
    mass,
    totalSompi,
  };
}

function parseScriptHex(txJson) {
  try {
    return JSON.parse(txJson).outputs?.[0]?.scriptPublicKey;
  } catch {
    return undefined;
  }
}

function normalizeEntry(entry) {
  const txid = entry?.transactionId ?? entry?.utxo?.transactionId ?? entry?.outpoint?.transactionId;
  const index = entry?.index ?? entry?.utxo?.index ?? entry?.outpoint?.index;
  const amount = entry?.amount ?? entry?.utxo?.amount;
  const script = toScriptHex(entry?.scriptPublicKey ?? entry?.utxo?.scriptPublicKey);
  return {
    transactionId: typeof txid === 'string' ? txid.toLowerCase() : txid,
    index,
    amount: toAmountBigInt(amount),
    scriptPublicKey: script,
    blockDaaScore: entry?.blockDaaScore ?? entry?.utxo?.blockDaaScore ?? 0n,
    isCoinbase: entry?.isCoinbase ?? entry?.utxo?.isCoinbase ?? false,
  };
}

function toAmountBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ProtocolError('INVALID_UTXO', 'UTXO amount must be a non-negative integer');
}

function toScriptHex(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.script === 'string') {
    return toScriptHex(value.script);
  }
  return '';
}

function estimateMass(inputCount, outputCount, inputs = []) {
  const perInput = 41 + 8;
  const scriptGrams = inputs.reduce((sum, input) => sum + hexByteLength(input?.scriptPublicKey), 0);
  const outputGrams = (outputCount ?? 1) * 47;
  return Math.max(101, Math.ceil(perInput * inputCount + scriptGrams + outputGrams));
}

function hexByteLength(value) {
  if (typeof value !== 'string') return 0;
  return Math.floor(value.length / 2);
}
