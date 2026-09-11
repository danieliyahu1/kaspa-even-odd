// Isomorphic client-side transaction builders for Even/Odd.
//
// These build every game action locally from explicit inputs (covenant state,
// UTXOs, secrets) using the shared, WASM-backed builders. A browser client uses
// them to construct and broadcast without a coordinating server; the Node tests
// exercise the exact same code paths.
import { NETWORK, ProtocolError, stakeToSompi } from './protocol.js';
import { deriveGameInstance } from './covenant/even-odd-core.mjs';
import { getCovenantTemplate } from './covenant/template.mjs';
import { blake2b256 } from './hashes/blake2b.mjs';
import { bytesToHex, hexToBytes } from './hashes/hex.mjs';
import { createWasmGenesisSafeJson } from './wasm-transaction.js';
import { estimateFunding } from './funding.mjs';
import { prepareJoinTransaction, serializeJoinTransaction } from './join-transactions.js';
import {
  prepareFallbackClaimTransaction,
  prepareIndividualRefundTransaction,
  prepareRevealTransaction,
  prepareTerminalTransaction,
  serializeTerminalTransaction,
} from './terminal-transactions.js';
import { parityOutcome, resolveReveal } from './reveal.js';
import { resolveFallbackClaim, resolveIndividualRefund } from './terminal-actions.js';

const SCRIPT_VERSION_HEX = '0000';

function template() {
  return getCovenantTemplate();
}

export function deriveCreationCovenant({ creatorPublicKey, creatorCommitment, side, stakeKas, deadlineDaa }) {
  return deriveGameInstance({
    creatorPubkey: creatorPublicKey,
    creatorCommit: creatorCommitment,
    potSompi: stakeToSompi(stakeKas),
    deadlineDaa: BigInt(deadlineDaa),
    creatorEven: side === 'even',
  }, { template: template() });
}

export function deriveJoinedCovenant({ creation, joinerPublicKey, joinerCommitment }) {
  return deriveGameInstance({
    creatorPubkey: creation.creatorPublicKey,
    creatorCommit: creation.creatorCommitment,
    joinerPubkey: joinerPublicKey,
    joinerCommit: joinerCommitment,
    potSompi: stakeToSompi(creation.stakeKas) * 2n,
    deadlineDaa: BigInt(creation.deadlineDaa),
    creatorEven: creation.side === 'even',
    status: 1,
  }, { template: template() });
}

export function buildCreationTx({ network = NETWORK, creatorAddress, creatorPublicKey, creatorCommitment, side, stakeKas, deadlineDaa, entries, feerate, changeScriptPublicKey }) {
  const covenant = deriveCreationCovenant({ creatorPublicKey, creatorCommitment, side, stakeKas, deadlineDaa });
  const covenantScriptPublicKey = bytesToHex(covenant.p2shScript);
  const request = {
    network,
    stakeSompi: stakeToSompi(stakeKas),
    feeSompi: 0n,
    covenantScriptPublicKey,
  };
  const funding = estimateFunding({ request, entries, feerate, feeOptions: { changeScriptPublicKey } });
  const prepared = createWasmGenesisSafeJson({
    request,
    authorizingInput: 0,
    inputs: funding.inputs,
    change: funding.change,
    feerate,
  });
  return Object.freeze({
    covenant,
    covenantAddress: covenant.address,
    covenantScriptPublicKey: `${SCRIPT_VERSION_HEX}${covenantScriptPublicKey}`,
    covenantId: prepared.covenantId,
    txJson: prepared.txJson,
    preparedHash: prepared.preparedHash,
    feeSompi: prepared.feeSompi,
    funding,
  });
}

export function buildJoinTx({ network = NETWORK, gameId, creation, joinerAddress, joinerPublicKey, joinerCommitment, creationUtxo, entries, feeSompi, changeScriptPublicKey }) {
  if (!creationUtxo?.covenantId) throw new ProtocolError('INVALID_UTXO', 'Creation UTXO must carry its covenant ID');
  const stakeSompi = stakeToSompi(creation.stakeKas);
  const state0 = deriveCreationCovenant({ ...creation });
  const joined = deriveJoinedCovenant({ creation, joinerPublicKey, joinerCommitment });
  const gameInput = {
    transactionId: gameId,
    index: 0,
    amount: stakeSompi,
    scriptPublicKey: creationUtxo.scriptPublicKey ?? `${SCRIPT_VERSION_HEX}${bytesToHex(state0.p2shScript)}`,
    blockDaaScore: creationUtxo.blockDaaScore ?? 0n,
    covenantId: creationUtxo.covenantId,
    redeemScript: bytesToHex(state0.redeemScript),
  };
  const potSompi = stakeSompi * 2n;
  const change = selectChange({ entries, targetSompi: stakeSompi + BigInt(feeSompi), changeScriptPublicKey });
  const prepared = prepareJoinTransaction({
    game: { potSompi: stakeSompi },
    joinerPublicKey,
    joinerCommitment,
    gameInput,
    feeInputs: change.inputs,
    feeSompi: BigInt(feeSompi),
    change: change.change,
    continuationScriptPublicKey: `${SCRIPT_VERSION_HEX}${bytesToHex(joined.p2shScript)}`,
    continuationCovenant: { authorizingInput: 0, covenantId: creationUtxo.covenantId },
  });
  const txJson = serializeJoinTransaction(prepared);
  return Object.freeze({
    joined,
    joinedAddress: joined.address,
    joinedScriptPublicKey: `${SCRIPT_VERSION_HEX}${bytesToHex(joined.p2shScript)}`,
    joinedRedeemScript: bytesToHex(joined.redeemScript),
    covenantId: creationUtxo.covenantId,
    txJson,
    feeSompi: BigInt(feeSompi),
  });
}

export function buildRevealTx({ gameId, game, caller, currentDaaScore, secret, gameInput, feeInputs, feeSompi, changeScriptPublicKey }) {
  const decision = resolveReveal({ game, caller, currentDaaScore, secret });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  const isFirst = !game.firstReveal;
  const continuation = isFirst ? deriveContinuation({ game, caller, decision }) : null;
  const winner = isFirst ? null : parityOutcome({
    creatorChoice: caller === game.creatorAddress ? decision.choice : game.creatorChoice,
    joinerChoice: caller === game.joinerAddress ? decision.choice : game.joinerChoice,
    creatorEven: game.creatorEven,
  });
  const change = selectChange({ entries: feeInputs, targetSompi: BigInt(feeSompi), changeScriptPublicKey });
  const recipient = winner
    ? (winner === 'creator' ? game.participants[game.creatorAddress].scriptPublicKey : game.participants[game.joinerAddress].scriptPublicKey)
    : `${SCRIPT_VERSION_HEX}${bytesToHex(continuation.p2shScript)}`;
  const prepared = prepareRevealTransaction({
    game,
    caller,
    currentDaaScore,
    secret,
    gameInput,
    recipientScriptPublicKey: recipient,
    continuationScriptPublicKey: isFirst ? `${SCRIPT_VERSION_HEX}${bytesToHex(continuation.p2shScript)}` : undefined,
    continuationCovenant: isFirst ? { authorizingInput: 0, covenantId: gameInput.covenantId } : undefined,
    feeInputs: change.inputs,
    feeSompi: BigInt(feeSompi),
    change: change.change,
    publicKey: callerPublicKey(game, caller),
    payoutPublicKey: winner
      ? callerPublicKey(game, winner === 'creator' ? game.creatorAddress : game.joinerAddress)
      : callerPublicKey(game, caller),
  });
  const txJson = serializeTerminalTransaction(prepared);
  return Object.freeze({ txJson, winner, continuation, feeSompi: BigInt(feeSompi) });
}

export function buildFallbackClaimTx({ gameId, game, caller, currentDaaScore, gameInput, feeInputs, feeSompi, changeScriptPublicKey }) {
  const decision = resolveFallbackClaim({ game, caller, currentDaaScore });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  const change = selectChange({ entries: feeInputs, targetSompi: BigInt(feeSompi), changeScriptPublicKey });
  const prepared = prepareFallbackClaimTransaction({
    game,
    caller,
    currentDaaScore,
    gameInput,
    recipientScriptPublicKey: game.participants[caller].scriptPublicKey,
    feeInputs: change.inputs,
    feeSompi: BigInt(feeSompi),
    change: change.change,
    publicKey: callerPublicKey(game, caller),
  });
  return Object.freeze({ txJson: serializeTerminalTransaction(prepared), feeSompi: BigInt(feeSompi) });
}

export function buildRefundTx({ gameId, game, caller, currentDaaScore, gameInput, continuation, feeInputs, feeSompi, changeScriptPublicKey }) {
  const decision = resolveIndividualRefund({ game, caller, currentDaaScore });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  const requiresContinuation = !Object.values(game.refunds ?? {}).some(Boolean);
  const change = selectChange({ entries: feeInputs, targetSompi: BigInt(feeSompi), changeScriptPublicKey });
  const prepared = prepareIndividualRefundTransaction({
    game,
    caller,
    currentDaaScore,
    gameInput,
    recipientScriptPublicKey: game.participants[caller].scriptPublicKey,
    continuationScriptPublicKey: requiresContinuation ? `${SCRIPT_VERSION_HEX}${bytesToHex(continuation.p2shScript)}` : undefined,
    continuationCovenant: requiresContinuation ? { authorizingInput: 0, covenantId: gameInput.covenantId } : undefined,
    feeInputs: change.inputs,
    feeSompi: BigInt(feeSompi),
    change: change.change,
    publicKey: callerPublicKey(game, caller),
  });
  return Object.freeze({ txJson: serializeTerminalTransaction(prepared), continuation, feeSompi: BigInt(feeSompi) });
}

export function buildCreatorRefundTx({ network = NETWORK, gameId, creation, gameInput, feeInputs, feeSompi, changeScriptPublicKey }) {
  const covenant = deriveCreationCovenant({ ...creation });
  const potSompi = stakeToSompi(creation.stakeKas);
  const change = selectChange({ entries: feeInputs, targetSompi: BigInt(feeSompi), changeScriptPublicKey });
  const prepared = prepareTerminalTransaction({
    action: 'refund',
    gameInput: { ...gameInput, amount: potSompi, redeemScript: bytesToHex(covenant.redeemScript) },
    lockTime: BigInt(creation.deadlineDaa),
    args: [creation.creatorPublicKey],
    payoutValue: potSompi,
    recipientScriptPublicKey: `000020${creation.creatorPublicKey}ac`,
    feeInputs: change.inputs,
    feeSompi: BigInt(feeSompi),
    change: change.change,
  });
  return Object.freeze({ txJson: serializeTerminalTransaction(prepared), feeSompi: BigInt(feeSompi) });
}

function deriveContinuation({ game, caller, decision }) {
  return deriveGameInstance({
    creatorPubkey: game.participants[game.creatorAddress].publicKey,
    creatorCommit: game.participants[game.creatorAddress].commitment,
    joinerPubkey: game.participants[game.joinerAddress].publicKey,
    joinerCommit: game.participants[game.joinerAddress].commitment,
    potSompi: BigInt(game.potSompi),
    deadlineDaa: BigInt(game.deadlineDaa),
    creatorEven: game.creatorEven,
    creatorChoice: caller === game.creatorAddress ? decision.choice : game.creatorChoice,
    joinerChoice: caller === game.joinerAddress ? decision.choice : game.joinerChoice,
    firstRevealerHash: blakeHash(callerPublicKey(game, caller)),
    status: 2,
  }, { template: template() });
}

function callerPublicKey(game, address) {
  const participant = game.participants[address];
  if (!participant?.publicKey) throw new ProtocolError('INVALID_GAME_STATE', 'Participant public key is required');
  return participant.publicKey;
}

function blakeHash(publicKeyHex) {
  // blake2b-256 of the x-only public key, matching the covenant's player hash.
  return bytesToHex(blake2b256(hexToBytes(publicKeyHex)));
}

function selectChange({ entries, targetSompi, changeScriptPublicKey }) {
  const selected = entries
    .map(normalizeEntry)
    .sort((a, b) => (b.amount === a.amount ? compareOutpoints(a, b) : b.amount < a.amount ? -1 : 1));
  const inputs = [];
  let total = 0n;
  for (const entry of selected) {
    inputs.push(entry);
    total += entry.amount;
    if (total >= targetSompi) break;
  }
  if (total < targetSompi) throw new ProtocolError('INSUFFICIENT_UTXOS', 'Wallet UTXOs cannot fund this action and its fee');
  const changeValue = total - targetSompi;
  return {
    inputs,
    change: changeValue > 0n ? { value: changeValue, scriptPublicKey: changeScriptPublicKey ?? inputs[0].scriptPublicKey } : undefined,
  };
}

function normalizeEntry(entry) {
  const txid = entry?.transactionId ?? entry?.utxo?.transactionId ?? entry?.outpoint?.transactionId;
  const index = entry?.index ?? entry?.utxo?.index ?? entry?.outpoint?.index;
  const amount = entry?.amount ?? entry?.utxo?.amount;
  const scriptPublicKey = entry?.scriptPublicKey ?? entry?.utxo?.scriptPublicKey;
  return {
    transactionId: String(txid).toLowerCase(),
    index,
    amount: BigInt(amount),
    scriptPublicKey,
    blockDaaScore: entry?.blockDaaScore ?? entry?.utxo?.blockDaaScore ?? 0n,
    isCoinbase: entry?.isCoinbase ?? entry?.utxo?.isCoinbase ?? false,
  };
}

function compareOutpoints(a, b) {
  if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? -1 : 1;
  return a.index - b.index;
}
