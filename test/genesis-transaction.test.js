import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreateGame } from '../src/create-game.js';
import {
  computeGenesisCovenantId,
  createGenesisGameOutput,
  validateCreationTransaction,
  verifySignedCreationSafeJson,
} from '../src/genesis-transaction.js';

const request = prepareCreateGame({
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'even',
  stakeKas: 1,
  feeSompi: 1000n,
});

test('computes the Rusty Kaspa v2.0.1 covenant-id oracle vector', () => {
  const output = {
    value: '100000000',
    scriptPublicKey: request.covenantScriptPublicKey,
    covenant: null,
  };
  assert.equal(
    computeGenesisCovenantId(
      { transactionId: '11'.repeat(32), index: 2 },
      [{ index: 0, output }],
    ),
    '561b76aa0567acdd7994a4895f7db23d94cd1ebaa46a4de690ed25b05910c0fb',
  );
});

test('constructs output zero with exact stake, P2SH, and genesis binding', () => {
  const output = createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: input() });
  assert.deepEqual(output, {
    value: '100000000',
    scriptPublicKey: '0000aa20e65da8645f2caeb6764c63c384e4cef83cf8798177ff2db66fbd2845425d94c187',
    covenant: {
      authorizingInput: 0,
      covenantId: '8102376fc02a60abd8b8c9151a666fa993a7e876d4ebc467c0c886ed15ed2368',
    },
  });
});

test('validates exact fee separation and approved change', () => {
  const changeScriptPublicKey = '000051';
  const transaction = tx({ inputAmount: request.stakeSompi + request.feeSompi + 50n, changeValue: 50n, changeScriptPublicKey });
  assert.deepEqual(validateCreationTransaction(JSON.stringify(transaction), request, { authorizingInput: 0, changeScriptPublicKey }), transaction);
});

test('rejects fee substitution, covenant fee inputs, and redirected change', () => {
  const insufficientFee = tx({ inputAmount: request.stakeSompi + request.feeSompi - 1n });
  assert.throws(() => validateCreationTransaction(JSON.stringify(insufficientFee), request, { authorizingInput: 0 }), { code: 'FEE_SUBSTITUTION' });

  const covenantInput = tx({ inputAmount: request.stakeSompi + request.feeSompi });
  covenantInput.inputs[0].utxo.covenantId = '22'.repeat(32);
  assert.throws(() => validateCreationTransaction(JSON.stringify(covenantInput), request, { authorizingInput: 0 }), { code: 'INVALID_TRANSACTION' });

  const redirected = tx({ inputAmount: request.stakeSompi + request.feeSompi + 50n, changeValue: 50n, changeScriptPublicKey: '000052' });
  assert.throws(() => validateCreationTransaction(JSON.stringify(redirected), request, { authorizingInput: 0, changeScriptPublicKey: '000051' }), { code: 'INVALID_TRANSACTION' });
});

test('allows only signature-script changes in wallet SafeJSON', () => {
  const prepared = tx({ inputAmount: request.stakeSompi + request.feeSompi });
  const signed = structuredClone(prepared);
  signed.inputs[0].signatureScript = '01aa';
  assert.deepEqual(verifySignedCreationSafeJson({
    preparedTxJson: JSON.stringify(prepared),
    signedTxJson: JSON.stringify(signed),
    request,
    policy: { authorizingInput: 0 },
  }), signed);

  signed.payload = '01';
  assert.throws(() => verifySignedCreationSafeJson({
    preparedTxJson: JSON.stringify(prepared),
    signedTxJson: JSON.stringify(signed),
    request,
    policy: { authorizingInput: 0 },
  }), { code: 'SIGNED_TRANSACTION_MISMATCH' });
});

function input(amount = request.stakeSompi + request.feeSompi) {
  return {
    transactionId: '11'.repeat(32),
    index: 2,
    sequence: '0',
    sigOpCount: 0,
    computeBudget: 0,
    signatureScript: '',
    utxo: {
      amount: String(amount),
      scriptPublicKey: '000051',
      blockDaaScore: '1',
      isCoinbase: false,
      covenantId: null,
    },
  };
}

function tx({ inputAmount, changeValue, changeScriptPublicKey } = {}) {
  const genesisInput = input(inputAmount);
  const outputs = [createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: genesisInput })];
  if (changeValue !== undefined) outputs.push({ value: String(changeValue), scriptPublicKey: changeScriptPublicKey, covenant: null });
  return {
    id: '00'.repeat(32),
    version: 1,
    inputs: [genesisInput],
    outputs,
    subnetworkId: '00'.repeat(20),
    lockTime: '0',
    gas: '0',
    storageMass: '0',
    payload: '',
  };
}
