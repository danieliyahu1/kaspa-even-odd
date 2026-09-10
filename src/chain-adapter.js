import { ProtocolError } from './protocol.js';
import { readAddressUtxos, submitSignedTransaction, KaspaCreationConfirmer } from './kaspa-adapter.js';
import { estimateCreationFee, selectOrdinaryUtxos, CREATION_MASS_BOUND } from './fee-policy.js';
import { estimateFunding } from './funding.mjs';
import { createWasmGenesisSafeJson, verifyWasmSignedSafeJson } from './wasm-transaction.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { prepareFallbackClaimTransaction, prepareIndividualRefundTransaction, prepareRevealTransaction, serializeTerminalTransaction } from './terminal-transactions.js';
import { prepareJoinTransaction, serializeJoinTransaction, verifySignedJoinTransaction } from './join-transactions.js';
import { reconstructGameState, recoveryOperationKey } from './recovery.js';

export { estimateFunding };

const DEFAULT_PRIORITY_BUCKET = 0;

export class KaspaChainAdapter {
  constructor({ rpc, covenantAddress, scriptPublicKey, outputIndex = 0, feeOptions, confidenceAttempts = 30, confidenceIntervalMs = 2_000, priorityBucket = DEFAULT_PRIORITY_BUCKET, recoveryStore }) {
    if (!rpc) throw new ProtocolError('RPC_UNAVAILABLE', 'Kaspa RPC client is required');
    this.rpc = rpc;
    this.covenantAddress = covenantAddress;
    this.scriptPublicKey = scriptPublicKey;
    this.outputIndex = outputIndex;
    this.feeOptions = feeOptions;
    this.priorityBucket = priorityBucket;
    this.confidenceAttempts = confidenceAttempts;
    this.confidenceIntervalMs = confidenceIntervalMs;
    this.recoveryStore = recoveryStore;
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
      payoutPublicKey: request.payoutPublicKey,
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
    if (typeof this.rpc.getGameState === 'function') return this.rpc.getGameState({ gameId, network });
    if (typeof this.rpc.getGameHistory !== 'function') throw new ProtocolError('CHAIN_UNAVAILABLE', 'RPC game-state reconstruction is not configured');
    const history = await this.rpc.getGameHistory({ gameId, network });
    const reduced = reconstructGameState(history);
    const result = reduced.state
      ? { ...reduced.state, gameId, network, confirmationStatus: reduced.status, pendingTransactions: reduced.pendingTransactions, checkpoint: reduced.checkpoint, rebuilt: reduced.rebuilt }
      : { gameId, network, confirmationStatus: reduced.status, pendingTransactions: reduced.pendingTransactions, conflicting: false, checkpoint: reduced.checkpoint, rebuilt: reduced.rebuilt };
    if (this.recoveryStore?.save) await this.recoveryStore.save({ key: recoveryOperationKey({ gameId, network }), gameId, network, checkpoint: reduced.checkpoint, status: reduced.status });
    return result;
  }

  async recoverGameState({ gameId, network }) {
    return this.readGameState({ gameId, network });
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

function parseScriptHex(txJson) {
  try {
    return JSON.parse(txJson).outputs?.[0]?.scriptPublicKey;
  } catch {
    return undefined;
  }
}
