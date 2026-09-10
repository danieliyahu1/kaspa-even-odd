// Short, identity-free summaries of how a wallet-mutated transaction differs
// from the prepared template. Used to make SIGNED_TRANSACTION_MISMATCH errors
// actionable in logs without dumping full scripts or transaction bodies.
import { blake2b256 } from './hashes/blake2b.mjs';
import { bytesToHex } from './hashes/hex.mjs';

const SUMMARY_FIELDS = ['version', 'lockTime', 'gas', 'subnetworkId', 'payload', 'storageMass', 'id'];

export function describeTransactionChanges(prepared, signed) {
  if (!prepared || !signed) return 'no comparison available';
  const diffs = [];
  const preparedInputs = prepared.inputs ?? [];
  const signedInputs = signed.inputs ?? [];
  if (preparedInputs.length !== signedInputs.length) {
    diffs.push(`inputs:${preparedInputs.length}->${signedInputs.length}`);
  }
  const inputCount = Math.min(preparedInputs.length, signedInputs.length);
  for (let index = 0; index < inputCount; index += 1) {
    const before = preparedInputs[index] ?? {};
    const after = signedInputs[index] ?? {};
    if (stableJson(omitSignature(before)) !== stableJson(omitSignature(after))) diffs.push(`input#${index}:fields`);
    if ((before.signatureScript ?? '') !== (after.signatureScript ?? '')) {
      diffs.push(`input#${index}:script ${describeScript(before.signatureScript)}->${describeScript(after.signatureScript)}`);
    }
  }
  const preparedOutputs = prepared.outputs ?? [];
  const signedOutputs = signed.outputs ?? [];
  if (preparedOutputs.length !== signedOutputs.length) diffs.push(`outputs:${preparedOutputs.length}->${signedOutputs.length}`);
  else if (stableJson(preparedOutputs) !== stableJson(signedOutputs)) diffs.push('outputs');
  for (const key of SUMMARY_FIELDS) {
    if (stableJson(prepared[key]) !== stableJson(signed[key])) diffs.push(key);
  }
  return diffs.length ? diffs.join(', ') : 'no differences outside input signature scripts';
}

export function describeScript(script) {
  if (typeof script !== 'string' || script.length === 0) return 'empty';
  return `${script.length}ch:${bytesToHex(blake2b256(new TextEncoder().encode(script))).slice(0, 8)}`;
}

export function unsignedInputs(inputs, fromIndex = 1) {
  return (inputs ?? [])
    .map((input, index) => ({ input, index }))
    .filter(({ index }) => index >= fromIndex)
    .filter(({ input }) => typeof input?.signatureScript !== 'string' || input.signatureScript.length === 0)
    .map(({ index }) => `#${index}`);
}

function omitSignature(input) {
  const copy = { ...input };
  delete copy.signatureScript;
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
