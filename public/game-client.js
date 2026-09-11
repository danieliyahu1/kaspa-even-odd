// Browser-side game client: builds, signs, broadcasts, and recovers Even/Odd
// games directly against a Kaspa wRPC node. The app server is not in this
// path; it can be replaced by any relay or by the invite URL alone.
import { WrpcClient } from '/src/wrpc.mjs';
import { initWasmSdk } from '/src/wasm-loader.mjs';
import { parseTemplateArtifact, deriveGameInstance } from '/src/covenant/even-odd-core.mjs';
import { setCovenantTemplate, getCovenantTemplate } from '/src/covenant/template.mjs';
import { blake2b256 } from '/src/hashes/blake2b.mjs';
import { bytesToHex, hexToBytes } from '/src/hashes/hex.mjs';
import { stakeToSompi } from '/src/protocol.js';
import { verifyWasmSignedSafeJson } from '/src/wasm-transaction.js';
import {
  buildCreationTx,
  buildJoinTx,
  buildRevealTx,
  buildFallbackClaimTx,
  buildRefundTx,
  buildCreatorRefundTx,
  deriveCreationCovenant,
  deriveJoinedCovenant,
} from '/src/client-actions.mjs';
import { createRevealSecret, loadSecretForGame, bindSecretToGame } from '/secrets.js';
import { FIVE_MINUTE_DAA_OFFSET, FALLBACK_CLAIM_DAA_OFFSET, NO_REVEAL_REFUND_DAA_OFFSET, safetyReadiness } from '/src/terminal-actions.js';
import { logDebug, logInfo, logError } from '/log.js';

const NETWORK = 'testnet-10';
const DEFAULT_FEE_SOMPI = 4_200_000n;
const GAMES_DB = 'kaspa-even-odd-games';
const GAMES_STORE = 'games';

let clientReady = null;

export function initClient() {
  if (clientReady) return clientReady;
  clientReady = (async () => {
    const [, artifact] = await Promise.all([
      initWasmSdk(),
      fetch('/covenant/even_odd.template.artifact.json').then((response) => {
        if (!response.ok) throw new Error('Covenant artifact could not be loaded');
        return response.json();
      }),
    ]);
    setCovenantTemplate(parseTemplateArtifact(artifact));
  })();
  return clientReady;
}

export async function createGame({ wallet, side, number, stakeKas, rpcUrl }) {
  await initClient();
  const rpc = new WrpcClient({ url: rpcUrl });
  const feerate = await readFeerate(rpc);
  const deadlineDaa = (await readDaa(rpc)) + FIVE_MINUTE_DAA_OFFSET;
  const secret = await createRevealSecret(number);
  const entries = (await rpc.getUtxosByAddresses([wallet.address])).entries;
  const built = buildCreationTx({
    network: NETWORK,
    creatorAddress: wallet.address,
    creatorPublicKey: wallet.publicKey,
    creatorCommitment: secret.commitment,
    side,
    stakeKas,
    deadlineDaa,
    entries,
    feerate,
  });
  const signed = await signAndVerify(wallet, built.txJson);
  const gameId = await rpc.submitSafeJson(signed);
  await waitForCovenant(rpc, {
    address: built.covenantAddress,
    transactionId: gameId,
    index: 0,
    valueSompi: stakeToSompi(stakeKas),
    scriptPublicKey: built.covenantScriptPublicKey,
  });
  await bindSecretToGame(gameId, secret.secretId);
  logInfo('client_create_broadcast');
  const record = {
    gameId,
    network: NETWORK,
    role: 'creator',
    creator: {
      address: wallet.address,
      publicKey: wallet.publicKey,
      commitment: secret.commitment,
      side,
      creatorPublicKey: wallet.publicKey,
      creatorCommitment: secret.commitment,
      stakeKas,
      deadlineDaa: String(deadlineDaa),
    },
    joiner: null,
    stakeKas,
    deadlineDaa: String(deadlineDaa),
    status: 'created',
    matchmaking: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveGame(record);
  return { gameId, inviteUrl: inviteUrl(gameId, { creatorPublicKey: wallet.publicKey, creatorCommitment: secret.commitment, side, stakeKas, deadlineDaa, creatorAddress: wallet.address }) };
}

export async function joinGame({ wallet, gameId, creation, number, rpcUrl }) {
  await initClient();
  const rpc = new WrpcClient({ url: rpcUrl });
  const state0 = deriveCreationCovenant(creation);
  const currentDaa = await readDaa(rpc);
  if (currentDaa >= BigInt(creation.deadlineDaa)) throw new Error('This game is no longer open to join');
  const creationUtxo = (await rpc.getUtxosByAddresses([state0.address])).entries
    .find((entry) => outpoint(entry).transactionId === gameId && outpoint(entry).index === 0);
  if (!creationUtxo) throw new Error('The game deposit is not available yet');
  const secret = await createRevealSecret(number);
  const entries = (await rpc.getUtxosByAddresses([wallet.address])).entries;
  const built = buildJoinTx({
    network: NETWORK,
    gameId,
    creation,
    joinerAddress: wallet.address,
    joinerPublicKey: wallet.publicKey,
    joinerCommitment: secret.commitment,
    creationUtxo: normalizeUtxo(creationUtxo),
    entries,
    feeSompi: DEFAULT_FEE_SOMPI,
  });
  const signed = await signAndVerify(wallet, built.txJson);
  const transactionId = await rpc.submitSafeJson(signed);
  logInfo('client_join_broadcast');
  await bindSecretToGame(gameId, secret.secretId);
  const record = await loadGame(gameId) ?? {
    gameId,
    network: NETWORK,
    role: 'joiner',
    creator: {
      ...creation,
      address: creation.creatorAddress ?? null,
      publicKey: creation.creatorPublicKey,
      commitment: creation.creatorCommitment,
      deadlineDaa: String(creation.deadlineDaa),
    },
    stakeKas: creation.stakeKas,
    deadlineDaa: String(creation.deadlineDaa),
    createdAt: new Date().toISOString(),
  };
  record.joiner = { address: wallet.address, publicKey: wallet.publicKey, commitment: secret.commitment };
  record.role = record.creator?.address === wallet.address ? 'creator' : 'joiner';
  record.status = 'joined';
  record.joinTransactionId = transactionId;
  record.joinedAddress = built.joinedAddress;
  record.joinedScriptPublicKey = built.joinedScriptPublicKey;
  record.joinedRedeemScript = built.joinedRedeemScript;
  record.covenantId = built.covenantId;
  record.updatedAt = new Date().toISOString();
  await saveGame(record);
  await publishRelay(record);
  return { gameId, transactionId };
}

async function publishRelay(record) {
  try {
    await fetch(`/api/relay/${record.gameId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(relayPayload(record)),
    });
  } catch {
    // The relay is optional; the game is still on-chain.
  }
}

function relayPayload(record) {
  return {
    gameId: record.gameId,
    creator: record.creator,
    joiner: record.joiner,
    stakeKas: record.stakeKas,
    deadlineDaa: record.deadlineDaa,
    joinTransactionId: record.joinTransactionId,
    joinedAddress: record.joinedAddress,
    joinedScriptPublicKey: record.joinedScriptPublicKey,
    joinedRedeemScript: record.joinedRedeemScript,
    covenantId: record.covenantId,
  };
}

async function hydrateRecord(record) {
  if (normalizeCreatorRecord(record)) await saveGame(record);
  if (record.joiner) return record;
  try {
    const response = await fetch(`/api/relay/${record.gameId}`);
    if (!response.ok) return record;
    const payload = await response.json();
    if (!payload?.joiner?.publicKey || !payload?.joinedAddress) return record;
    // Verify the relayed join on-chain by re-deriving the joined covenant.
    const joined = deriveJoinedCovenant({ creation: record.creator, joinerPublicKey: payload.joiner.publicKey, joinerCommitment: payload.joiner.commitment });
    if (joined.address !== payload.joinedAddress || `0000${bytesToHex(joined.p2shScript)}` !== payload.joinedScriptPublicKey) return record;
    Object.assign(record, {
      joiner: payload.joiner,
      joinTransactionId: payload.joinTransactionId,
      joinedAddress: payload.joinedAddress,
      joinedScriptPublicKey: payload.joinedScriptPublicKey,
      joinedRedeemScript: bytesToHex(joined.redeemScript),
      covenantId: payload.covenantId,
      status: 'joined',
      updatedAt: new Date().toISOString(),
    });
    await saveGame(record);
    return record;
  } catch {
    return record;
  }
}

export async function reveal({ wallet, gameId, rpcUrl }) {
  await initClient();
  const rpc = new WrpcClient({ url: rpcUrl });
  const record = await loadGame(gameId);
  if (!record) throw new Error('This browser has no saved game to reveal');
  await hydrateRecord(record);
  const secret = await loadSecretForGame(gameId);
  if (!secret) throw new Error('This browser does not have your unrevealed number');
  const role = record.creator?.address === wallet.address ? 'creator' : 'joiner';
  const state = await readCovenantState(rpc, record);
  const game = buildRevealGameState(record, state, wallet.address);
  const currentDaa = await readDaa(rpc);
  const built = buildRevealTx({
    gameId,
    game,
    caller: wallet.address,
    currentDaaScore: currentDaa,
    secret: { gameId, player: wallet.address, choice: secret.choice, nonceHex: secret.nonceHex },
    gameInput: state.gameInput,
    feeInputs: (await rpc.getUtxosByAddresses([wallet.address])).entries,
    feeSompi: DEFAULT_FEE_SOMPI,
  });
  const signed = await signAndVerify(wallet, built.txJson);
  const transactionId = await rpc.submitSafeJson(signed);
  record.reveals = { ...(record.reveals ?? {}) };
  record.reveals[role] = { transactionId, choice: secret.choice, status: 'broadcast' };
  record.status = built.winner ? 'settlement_broadcast' : 'first_reveal_broadcast';
  if (built.winner) record.winner = built.winner;
  if (!built.winner && built.continuation) {
    record.firstRevealer = role;
    record.continuationAddress = built.continuation.address;
    record.continuationScriptPublicKey = `0000${bytesToHex(built.continuation.p2shScript)}`;
    record.continuationRedeemScript = bytesToHex(built.continuation.redeemScript);
  }
  record.updatedAt = new Date().toISOString();
  await saveGame(record);
  logInfo('client_reveal_broadcast', { winner: built.winner });
  return { gameId, transactionId, winner: built.winner };
}

export async function refundOrClaim({ wallet, gameId, rpcUrl }) {
  logInfo('client_recover_start');
  await initClient();
  const rpc = new WrpcClient({ url: rpcUrl });
  const record = await loadGame(gameId);
  if (!record) throw new Error('This browser has no saved game to recover');
  await hydrateRecord(record);
  const state = await readCovenantState(rpc, record);
  const currentDaa = await readDaa(rpc);
  const feeInputs = (await rpc.getUtxosByAddresses([wallet.address])).entries;

  if (!record.joiner) {
    // Unmatched creation: creator reclaims after the join deadline.
    if (BigInt(record.deadlineDaa) > currentDaa) throw new Error('The join deadline has not passed yet');
    const built = buildCreatorRefundTx({
      gameId,
      creation: record.creator,
      gameInput: state.gameInput,
      feeInputs,
      feeSompi: DEFAULT_FEE_SOMPI,
    });
    const signed = await signAndVerify(wallet, built.txJson);
    const transactionId = await rpc.submitSafeJson(signed);
    record.status = 'creator_refund_broadcast';
    await saveGame(record);
    return { gameId, transactionId, action: 'creator_refund' };
  }

  const role = record.creator?.address === wallet.address ? 'creator' : 'joiner';
  const revealedCount = Object.keys(record.reveals ?? {}).length;
  if (revealedCount === 1 && record.reveals[role]) {
    // You revealed first; claim the pot after the opponent's window.
    if (state.blockDaaScore + FALLBACK_CLAIM_DAA_OFFSET > currentDaa) throw new Error('The opponent still has time to reveal');
    const game = buildRevealGameState(record, state, wallet.address);
    const built = buildFallbackClaimTx({ gameId, game, caller: wallet.address, currentDaaScore: currentDaa, gameInput: state.gameInput, feeInputs, feeSompi: DEFAULT_FEE_SOMPI });
    const signed = await signAndVerify(wallet, built.txJson);
    const transactionId = await rpc.submitSafeJson(signed);
    record.status = 'fallback_claimed_broadcast';
    await saveGame(record);
    return { gameId, transactionId, action: 'fallback_claim' };
  }

  // No reveals: each player refunds their own stake after the wait.
  if (revealedCount > 0) throw new Error('A reveal exists; refund is not available');
  if (state.blockDaaScore + NO_REVEAL_REFUND_DAA_OFFSET > currentDaa) throw new Error('The refund wait has not elapsed');
  const game = buildRevealGameState(record, state, wallet.address);
  const firstRefund = Object.values(record.refunds ?? {}).some(Boolean);
  const continuation = firstRefund ? null : deriveJoinedCovenant({ creation: record.creator, joinerPublicKey: record.joiner.publicKey, joinerCommitment: record.joiner.commitment });
  const built = buildRefundTx({ gameId, game, caller: wallet.address, currentDaaScore: currentDaa, gameInput: state.gameInput, continuation, feeInputs, feeSompi: DEFAULT_FEE_SOMPI });
  const signed = await signAndVerify(wallet, built.txJson);
  const transactionId = await rpc.submitSafeJson(signed);
  record.refunds = { ...(record.refunds ?? {}), [role]: true };
  record.status = Object.keys(record.refunds).length === 2 ? 'refunded' : 'refund_partial';
  await saveGame(record);
  return { gameId, transactionId, action: 'refund_player' };
}

async function readCovenantState(rpc, record) {
  let descriptor = stateDescriptor(record);
  let found = await findUtxo(rpc, descriptor);
  if (!found && record.joiner && !record.firstRevealer) {
    // The opponent may have revealed first. Discover the continuation from the
    // optional relay, then verify it on-chain by deriving the covenant locally.
    const discovery = await discoverFirstReveal(record);
    if (discovery) {
      const continuation = deriveContinuation(record, discovery.firstRole);
      record.reveals = { ...(record.reveals ?? {}), [discovery.firstRole]: { choice: discovery.choice, status: 'confirmed' } };
      record.firstRevealer = discovery.firstRole;
      record.continuationAddress = continuation.address;
      record.continuationScriptPublicKey = `0000${bytesToHex(continuation.p2shScript)}`;
      record.continuationRedeemScript = bytesToHex(continuation.redeemScript);
      await saveGame(record);
      descriptor = { address: continuation.address, outputIndex: 0, redeemScript: bytesToHex(continuation.redeemScript) };
      found = await findUtxo(rpc, descriptor);
    }
  }
  if (!found) throw new Error('The current game output is not available yet');
  return {
    entry: found.entry,
    blockDaaScore: found.blockDaaScore,
    gameInput: {
      transactionId: found.transactionId,
      index: found.outputIndex,
      amount: found.amount,
      scriptPublicKey: found.scriptPublicKey,
      blockDaaScore: found.blockDaaScore,
      covenantId: found.covenantId,
      redeemScript: descriptor.redeemScript,
    },
  };
}

async function findUtxo(rpc, descriptor) {
  const entries = (await rpc.getUtxosByAddresses([descriptor.address])).entries;
  const entry = entries.find((candidate) => {
    const op = outpoint(candidate);
    if (descriptor.transactionId && op.transactionId !== descriptor.transactionId) return false;
    if (descriptor.outputIndex !== undefined && op.index !== descriptor.outputIndex) return false;
    if (descriptor.scriptPublicKey && normalizeUtxo(candidate).scriptPublicKey !== descriptor.scriptPublicKey) return false;
    return true;
  });
  if (!entry) return null;
  const normalized = normalizeUtxo(entry);
  return {
    entry,
    transactionId: outpoint(entry).transactionId,
    outputIndex: outpoint(entry).index,
    amount: normalized.amount,
    scriptPublicKey: normalized.scriptPublicKey,
    blockDaaScore: normalized.blockDaaScore,
    covenantId: normalized.covenantId,
  };
}

function stateDescriptor(record) {
  const firstRevealRole = record.firstRevealer;
  if (record.reveals && firstRevealRole && !record.winner && record.continuationAddress) {
    return { address: record.continuationAddress, outputIndex: 0, redeemScript: record.continuationRedeemScript };
  }
  return { address: record.joinedAddress, outputIndex: 0, redeemScript: record.joinedRedeemScript };
}

function deriveContinuation(record, firstRole) {
  const firstPublicKey = record[firstRole].publicKey;
  return deriveGameInstance({
    creatorPubkey: record.creator.publicKey,
    creatorCommit: record.creator.commitment,
    joinerPubkey: record.joiner.publicKey,
    joinerCommit: record.joiner.commitment,
    potSompi: stakeToSompi(record.stakeKas) * 2n,
    deadlineDaa: BigInt(record.deadlineDaa),
    creatorEven: record.creator.side === 'even',
    creatorChoice: firstRole === 'creator' ? record.reveals.creator.choice : 0,
    joinerChoice: firstRole === 'joiner' ? record.reveals.joiner.choice : 0,
    firstRevealerHash: bytesToHex(blake2b256(hexToBytes(firstPublicKey))),
    status: 2,
  }, { template: getCovenantTemplate() });
}

async function discoverFirstReveal(record) {
  try {
    const response = await fetch(`/api/games/${record.gameId}`);
    if (!response.ok) return null;
    const game = await response.json();
    if (game.status !== 'first_revealed' || !game.revealedPicks) return null;
    const firstRole = game.firstRevealer === record.creator?.address ? 'creator' : 'joiner';
    const choice = game.revealedPicks[firstRole];
    if (choice !== 0 && choice !== 1) return null;
    return { firstRole, choice };
  } catch {
    return null;
  }
}

function buildRevealGameState(record, state, walletAddress) {
  const participants = {};
  if (record.creator?.address) participants[record.creator.address] = { publicKey: record.creator.publicKey, commitment: record.creator.commitment, scriptPublicKey: p2pkScript(record.creator.publicKey) };
  if (record.joiner?.address) participants[record.joiner.address] = { publicKey: record.joiner.publicKey, commitment: record.joiner.commitment, scriptPublicKey: p2pkScript(record.joiner.publicKey) };
  const firstRole = record.firstRevealer;
  return {
    gameId: record.gameId,
    confirmationStatus: 'confirmed',
    joinedDaaScore: state.blockDaaScore,
    currentDaaScore: state.blockDaaScore + 1n,
    creatorAddress: record.creator?.address,
    joinerAddress: record.joiner?.address,
    creatorEven: record.creator?.side === 'even',
    creatorChoice: record.reveals?.creator?.choice ?? 0,
    joinerChoice: record.reveals?.joiner?.choice ?? 0,
    potSompi: stakeToSompi(record.stakeKas) * 2n,
    stakeSompi: stakeToSompi(record.stakeKas),
    deadlineDaa: BigInt(record.deadlineDaa),
    participants,
    commitments: Object.fromEntries(Object.entries(participants).map(([address, value]) => [address, value.commitment])),
    reveals: Object.fromEntries(
      Object.entries(record.reveals ?? {})
        .filter(([, value]) => value && (value.status === 'confirmed' || value.status === 'broadcast'))
        .map(([role]) => [record[role]?.address, true])
        .filter(([address]) => Boolean(address)),
    ),
    firstReveal: firstRole && record[firstRole]?.address ? { player: record[firstRole].address } : null,
    refunds: record.refunds ?? {},
    noRevealRefundDeadlineDaa: state.blockDaaScore + NO_REVEAL_REFUND_DAA_OFFSET,
  };
}

// Records created before the reveal-key bug stored the creator as `{ ...invite,
// address }`, exposing `creatorPublicKey`/`creatorCommitment` but not the
// `publicKey`/`commitment` names the reveal and recovery paths read. Normalize
// every loaded record to the canonical shape with BOTH key sets plus a
// JSON-safe deadline, and report whether storage needs updating.
function normalizeCreatorRecord(record) {
  const creator = record?.creator;
  if (typeof creator !== 'object' || creator === null) return false;
  const publicKey = creator.publicKey ?? creator.creatorPublicKey;
  const commitment = creator.commitment ?? creator.creatorCommitment;
  let deadlineDaa = creator.deadlineDaa ?? record.deadlineDaa;
  if (typeof deadlineDaa === 'bigint') deadlineDaa = String(deadlineDaa);
  const normalized = {
    address: creator.address ?? creator.creatorAddress ?? null,
    publicKey,
    commitment,
    side: creator.side,
    creatorPublicKey: publicKey,
    creatorCommitment: commitment,
    stakeKas: creator.stakeKas ?? record.stakeKas,
    deadlineDaa,
  };
  const same = ['address', 'publicKey', 'commitment', 'side', 'creatorPublicKey', 'creatorCommitment', 'stakeKas', 'deadlineDaa']
    .every((key) => creator[key] === normalized[key]);
  if (same) return false;
  record.creator = normalized;
  return true;
}

export async function readFeerate(rpc) {
  try {
    const estimate = await rpc.getFeeEstimate();
    const bucket = estimate?.estimate?.priorityBucket?.[0];
    return Number(bucket?.feerate ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function readDaa(rpc) {
  const dag = await rpc.getBlockDagInfo();
  return BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString);
}

// Reads the chain directly to decide whether a refund/claim is available yet.
// The server only points at the public covenant output; the timing truth comes
// from the node, and the covenant enforces it again on-chain.
export async function readRecoveryReadiness({ rpcUrl, action, deadlineDaa, output }) {
  const rpc = new WrpcClient({ url: rpcUrl });
  const currentDaa = await readDaa(rpc);
  if (action === 'creator_refund') return safetyReadiness(currentDaa, BigInt(deadlineDaa));
  const offset = action === 'fallback_claim' ? FALLBACK_CLAIM_DAA_OFFSET : NO_REVEAL_REFUND_DAA_OFFSET;
  const descriptor = { address: output?.address, outputIndex: output?.outputIndex ?? 0, scriptPublicKey: output?.scriptPublicKey };
  if (!descriptor.address) return { ready: false, remainingSeconds: null };
  const found = await findUtxo(rpc, descriptor);
  if (!found) return { ready: false, remainingSeconds: null };
  return safetyReadiness(currentDaa, found.blockDaaScore + offset);
}

export async function waitForCovenant(rpc, { address, transactionId, index, valueSompi, scriptPublicKey }) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [entries, daa] = await Promise.all([rpc.getUtxosByAddresses([address]), readDaa(rpc)]);
    const entry = entries.entries.find((candidate) => {
      const op = outpoint(candidate);
      return op.transactionId === transactionId && op.index === index
        && BigInt(candidate.amount ?? candidate.utxo?.amount) === valueSompi
        && (!scriptPublicKey || normalizeUtxo(candidate).scriptPublicKey === scriptPublicKey);
    });
    if (entry && daa >= BigInt(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0n) + 1n) return entry;
    await delay(2_000);
  }
  throw new Error('The game transaction did not confirm in time');
}

async function signAndVerify(wallet, txJson) {
  logDebug('client_sign_start');
  const signed = await wallet.signTx(txJson);
  if (!signed) {
    logError('client_sign_empty');
    throw new Error('KasWare did not return a signed transaction');
  }
  verifyWasmSignedSafeJson({ preparedTxJson: txJson, signedTxJson: signed, policy: {} });
  logDebug('client_sign_verified');
  return signed;
}

function inviteUrl(gameId, creation) {
  const url = new URL('/join', location.origin);
  url.searchParams.set('v', 'EO/v2');
  url.searchParams.set('game', gameId);
  url.searchParams.set('pk', creation.creatorPublicKey);
  url.searchParams.set('c', creation.creatorCommitment);
  url.searchParams.set('s', creation.side === 'even' ? 'e' : 'o');
  url.searchParams.set('k', String(creation.stakeKas));
  url.searchParams.set('d', String(creation.deadlineDaa));
  if (creation.creatorAddress) url.searchParams.set('a', creation.creatorAddress);
  return url.toString();
}

function p2pkScript(publicKey) {
  return `000020${publicKey}ac`;
}

function normalizeUtxo(entry) {
  const op = outpoint(entry);
  const scriptPublicKey = entry.scriptPublicKey ?? entry.utxo?.scriptPublicKey;
  return {
    transactionId: op.transactionId,
    index: op.index,
    amount: BigInt(entry.amount ?? entry.utxo?.amount),
    scriptPublicKey: typeof scriptPublicKey === 'string' ? scriptPublicKey : `${Number(scriptPublicKey?.version ?? 0).toString(16).padStart(4, '0')}${scriptPublicKey?.script ?? ''}`,
    blockDaaScore: BigInt(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0n),
    isCoinbase: entry.isCoinbase ?? entry.utxo?.isCoinbase ?? false,
    covenantId: entry.covenantId ?? entry.utxo?.covenantId ?? null,
  };
}

function outpoint(entry) {
  return {
    transactionId: (entry.transactionId ?? entry.outpoint?.transactionId ?? entry.utxo?.transactionId ?? '').toLowerCase(),
    index: entry.index ?? entry.outpoint?.index ?? entry.utxo?.index ?? 0,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Local (non-secret) game metadata store ---

function openGames() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is unavailable in this browser'));
    const request = indexedDB.open(GAMES_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(GAMES_STORE)) request.result.createObjectStore(GAMES_STORE, { keyPath: 'gameId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function saveGame(record) {
  const db = await openGames();
  await requestResult(db.transaction(GAMES_STORE, 'readwrite').objectStore(GAMES_STORE).put(record));
}

export async function loadGame(gameId) {
  const db = await openGames();
  return requestResult(db.transaction(GAMES_STORE, 'readonly').objectStore(GAMES_STORE).get(gameId));
}

export async function loadHydratedGame(gameId) {
  const record = await loadGame(gameId);
  if (!record) return null;
  return hydrateRecord(record);
}

export async function listGames() {
  const db = await openGames();
  return requestResult(db.transaction(GAMES_STORE, 'readonly').objectStore(GAMES_STORE).getAll());
}

export async function exportRecoveryBundle() {
  return { version: 1, network: NETWORK, games: await listGames() };
}
