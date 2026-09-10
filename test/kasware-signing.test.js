import test from 'node:test';
import assert from 'node:assert/strict';
import { signingInputsFor, signWithKasware } from '../public/kasware-signing.js';

const creationTx = JSON.stringify({ inputs: [{ signatureScript: '', utxo: { covenantId: null } }] });
const joinTx = JSON.stringify({
  inputs: [
    { signatureScript: 'aa'.repeat(1491), utxo: { covenantId: 'cc'.repeat(32) } },
    { signatureScript: '', utxo: { covenantId: null } },
  ],
});

test('signs every funding input of a creation transaction', () => {
  assert.deepEqual(signingInputsFor(creationTx), [{ index: 0, sighashType: 1 }]);
});

test('never signs a covenant input that already carries its entry script', () => {
  assert.deepEqual(signingInputsFor(joinTx), [{ index: 1, sighashType: 1 }]);
});

test('passes explicit signInputs to KasWare signPskt', async () => {
  let received;
  const provider = { signPskt: async (request) => { received = request; return 'signed'; } };
  const result = await signWithKasware(provider, joinTx);
  assert.equal(result, 'signed');
  assert.equal(received.txJsonString, joinTx);
  assert.deepEqual(received.options, { signInputs: [{ index: 1, sighashType: 1 }] });
});

test('rejects a transaction with no wallet-signable input', () => {
  assert.throws(() => signingInputsFor(JSON.stringify({ inputs: [{ signatureScript: 'ab' }] })), /no wallet inputs/);
  assert.throws(() => signingInputsFor('not json'), /not valid JSON/);
});
