import { ProtocolError } from './protocol.js';
import { readAddressUtxos, submitSignedTransaction, KaspaCreationConfirmer } from './kaspa-adapter.js';
import { estimateCreationFee, selectOrdinaryUtxos, CREATION_MASS_BOUND } from './fee-policy.js';
import { createWasmGenesisSafeJson, verifyWasmSignedSafeJson } from './wasm-transaction.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { prepareFallbackClaimTransaction, prepareIndividualRefundTransaction, prepareRevealTransaction, serializeTerminalTransaction } from './terminal-transactions.js';
import { prepareJoinTransaction, serializeJoinTransaction, verifySignedJoinTransaction } from './join-transactions.js';

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

  async prepareJoin({ request, game }) {
    const utxos = await readAddressUtxos({ rpc: this.rpc, addresses: [request.joinerAddress] });
    const entries = Array.isArray(utxos) ? utxos : utxos?.entries ?? [];
    const feeSompi = request.feeSompi ?? 0n;
    const potSompi = BigInt(game.potSompi);
    const selected = selectOrdinaryUtxos({ utxos: entries, targetSompi: potSompi + feeSompi }).selected;
    const selectedEntries = entries.filter((entry) => selected.some((item) => (entry.transactionId ?? entry.outpoint?.transactionId)?.toLowerCase() === item.transactionId && (entry.index ?? entry.outpoint?.index) === item.index));
    const total = selectedEntries.reduce((sum, entry) => sum + BigInt(entry.amount ?? entry.utxo?.amount), 0n);
    const change = total > potSompi + feeSompi ? { value: total - potSompi - feeSompi, scriptPublicKey: request.changeScriptPublicKey ?? selectedEntries[0]?.scriptPublicKey ?? selectedEntries[0]?.utxo?.scriptPublicKey } : undefined;
    const transaction = prepareJoinTransaction({ game, joinerPublicKey: request.joinerPublicKey, joinerCommitment: request.joinerCommitment, gameInput: game.currentInput, feeInputs: selectedEntries, feeSompi, change, continuationScriptPublicKey: request.continuationScriptPublicKey ?? game.continuationScriptPublicKey, continuationCovenant: request.continuationCovenant ?? game.continuationCovenant });
    const txJson = serializeJoinTransaction(transaction);
    return Object.freeze({ network: request.network, joinerAddress: request.joinerAddress, txJson, preparedHash: Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'), feeSompi, gameId: request.gameId });
  }

  async verifySignedJoin({ prepared, signedTxJson }) {
    verifySignedJoinTransaction({ preparedTxJson: prepared.txJson, signedTxJson });
    return { network: prepared.network };
  }

  async submitJoin({ signedTxJson }) {
    return submitSignedTransaction({ rpc: this.rpc, transaction: JSON.parse(signedTxJson) });
  }

  async confirmJoin({ transactionId }) {
    return this.confirmTerminal({ transactionId });
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

  async prepareTerminalAction({ action, request, game }) {
    const builder = { reveal: prepareRevealTransaction, fallback_claim: prepareFallbackClaimTransaction, individual_refund: prepareIndividualRefundTransaction }[action];
    if (!builder) throw new ProtocolError('UNSUPPORTED_ACTION', `Unsupported terminal action ${action}`);
    const prepared = builder({
      game,
      caller: request.caller,
      currentDaaScore: request.currentDaaScore ?? game.currentDaaScore,
      secret: request.secret,
      gameInput: request.gameInput ?? game.currentInput,
      recipientScriptPublicKey: request.recipientScriptPublicKey,
      continuationScriptPublicKey: request.continuationScriptPublicKey,
      continuationCovenant: request.continuationCovenant,
      feeInputs: request.feeInputs ?? [],
      feeSompi: request.feeSompi ?? 0n,
      change: request.change,
      signature: request.signature,
      publicKey: request.publicKey,
    });
    const txJson = serializeTerminalTransaction(prepared);
    return Object.freeze({
      txJson,
      preparedHash: Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'),
      feeSompi: prepared.feeSompi,
      action,
    });
  }

  async submitTerminal({ signedTxJson }) {
    let transaction;
    try {
      transaction = JSON.parse(signedTxJson);
    } catch {
      throw new ProtocolError('INVALID_TRANSACTION', 'Signed terminal SafeJSON is invalid');
    }
    return submitSignedTransaction({ rpc: this.rpc, transaction });
  }

  async confirmTerminal({ transactionId }) {
    if (typeof this.rpc.confirmTransaction === 'function') {
      return this.rpc.confirmTransaction({ transactionId, confirmations: 1 });
    }
    if (typeof this.rpc.getTransaction === 'function') {
      const transaction = await this.rpc.getTransaction({ transactionId });
      if (transaction?.isConfirmed === true || transaction?.status === 'confirmed') {
        return { status: 'confirmed', acceptingDaaScore: transaction.acceptingDaaScore, confirmedDaaScore: transaction.confirmedDaaScore };
      }
      return { status: transaction ? 'observed' : 'stale' };
    }
    return { status: 'observed' };
  }

  async readGameState({ gameId, network }) {
    if (typeof this.rpc.getGameState !== 'function') throw new ProtocolError('CHAIN_UNAVAILABLE', 'RPC game-state reconstruction is not configured');
    return this.rpc.getGameState({ gameId, network });
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
