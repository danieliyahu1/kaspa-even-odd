import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTransactionChanges, describeScript, unsignedInputs } from '../src/transaction-diagnostics.js';

test('describes covenant signature-script changes without leaking full scripts', () => {
  const prepared = { inputs: [{ transactionId: 'aa', signatureScript: '2050ab' }, { signatureScript: '' }], outputs: [{ value: '1' }], version: 1 };
  const signed = { inputs: [{ transactionId: 'aa', signatureScript: 'deadbeef' }, { signatureScript: 'sig' }], outputs: [{ value: '1' }], version: 1 };
  const summary = describeTransactionChanges(prepared, signed);
  assert.match(summary, /input#0:script 6ch:[0-9a-f]{8}->8ch:[0-9a-f]{8}/);
  assert.match(summary, /input#1:script empty->/);
  assert.doesNotMatch(summary, /2050ab|deadbeef/);
  assert.doesNotMatch(summary, /outputs/);
});

test('reports output and summary-field changes', () => {
  const summary = describeTransactionChanges(
    { inputs: [], outputs: [{ value: '1' }], version: 1 },
    { inputs: [], outputs: [{ value: '2' }], version: 2 },
  );
  assert.match(summary, /outputs/);
  assert.match(summary, /version/);
});

test('describes scripts by length and short hash and lists unsigned inputs', () => {
  assert.equal(describeScript(''), 'empty');
  assert.match(describeScript('aa'.repeat(10)), /^20ch:[0-9a-f]{8}$/);
  assert.deepEqual(unsignedInputs([{ signatureScript: 'ab' }, { signatureScript: '' }, {}], 1), ['#1', '#2']);
  assert.deepEqual(unsignedInputs([{ signatureScript: 'ab' }, { signatureScript: 'cd' }], 1), []);
});
