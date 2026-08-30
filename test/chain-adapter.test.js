import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreateGame } from '../src/create-game.js';
import { estimateFunding, KaspaChainAdapter } from '../src/chain-adapter.js';
import { validateCreationTransaction } from '../src/genesis-transaction.js';

const STAKE_KAS = 5;
const request = prepareCreateGame({
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000n,
  side: 'odd',
  stakeKas: STAKE_KAS,
  feeSompi: 0n,
});

function utxo(amount, txid, index = 0, extra = {}) {
  return { outpoint: { transactionId: txid, index }, amount: String(amount), ...extra };
}

test('estimateFunding selects ordinary inputs covering stake plus fee', () => {
  const stake = request.stakeSompi;
  const entries = [
    utxo(50n, 'c3'.repeat(32)),
    utxo(stake + 1_000_000n, 'b2'.repeat(32)),
    utxo(stake, 'a1'.repeat(32)),
  ];
  const funding = estimateFunding({ request, entries, feerate: 0.5 });
  const totalIn = funding.inputs.reduce((sum, i) => sum + i.amount, 0n);
  assert.ok(totalIn >= stake + funding.feeSompi);
  assert.equal(funding.feeSompi > 0n, true);
  if (funding.change) {
    assert.equal(totalIn - (stake + funding.feeSompi) === funding.change.value, true);
  }
});

test('game value is never spent on fees', () => {
  const stake = request.stakeSompi;
  const entries = [utxo(stake + 10_000_000n, 'b2'.repeat(32))];
  const funding = estimateFunding({ request, entries, feerate: 1 });
  const fee = funding.feeSompi;
  assert.ok(fee > 0n);
  assert.ok(fee <= 10_000_000n, 'fee within funded bounds');
  const gameCovered = funding.inputs.reduce((sum, i) => sum + i.amount, 0n) - fee;
  assert.ok(gameCovered >= stake);
});

test('exact fee separation between game output and fees', () => {
  const stake = request.stakeSompi;
  const entries = [utxo(stake + 10_000_000n, 'b2'.repeat(32))];
  const funding = estimateFunding({ request, entries, feerate: 0.5 });
  const { inputs, change, feeSompi } = funding;
  const totalIn = inputs.reduce((sum, i) => sum + i.amount, 0n);
  const totalOut = stake + (change ? change.value : 0n);
  assert.equal(totalIn - totalOut, feeSompi);
});

test('prepareCreation builds a WASM tx, fetches fee, and separates fees', async () => {
  const rpc = {
    getUtxosByAddresses: async () => ({
      entries: [
        utxo(request.stakeSompi + 2_000_000_000n, 'b2'.repeat(32), 0, { scriptPublicKey: '000051', blockDaaScore: '1' }),
      ],
    }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    submitTransaction: async () => ({ transactionId: 'aa'.repeat(32) }),
  };
  const adapter = new KaspaChainAdapter({ rpc, covenantAddress: 'kaspatest:covenant', scriptPublicKey: request.covenantScriptPublicKey, feeOptions: { changeScriptPublicKey: '000051' } });
  const prepared = await adapter.prepareCreation(request);
  assert.ok(prepared.txJson);
  assert.match(prepared.preparedHash, /^[0-9a-f]{64}$/);
  assert.ok(prepared.feeSompi > 0n);
  assert.ok(prepared.covenantId);

  const signed = JSON.parse(prepared.txJson);
  signed.id = 'fe'.repeat(32);
  signed.inputs[0].signatureScript = '01aa';
  validateCreationTransaction(prepared.txJson, request, { ...prepared.policy, changeScriptPublicKey: '000051' });
  const verified = await adapter.verifySignedCreation({ prepared, signedTxJson: JSON.stringify(signed) });
  assert.equal(verified.policy.authorizingInput, prepared.policy.authorizingInput);
});

test('prepareCreation rejects when the creator cannot fund the game and fee', async () => {
  const rpc = {
    getUtxosByAddresses: async () => ({ entries: [utxo(100n, 'b2'.repeat(32))] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
  };
  const adapter = new KaspaChainAdapter({ rpc, covenantAddress: 'kaspatest:covenant', scriptPublicKey: request.covenantScriptPublicKey, feeOptions: { changeScriptPublicKey: '000051' } });
  await assert.rejects(() => adapter.prepareCreation(request), { code: 'INSUFFICIENT_UTXOS' });
});
