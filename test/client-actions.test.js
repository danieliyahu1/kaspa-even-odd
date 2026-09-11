import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreationTx, buildJoinTx, deriveCreationCovenant, deriveJoinedCovenant, buildRevealTx } from '../src/client-actions.mjs';
import { bytesToHex } from '../src/hashes/hex.mjs';
import { createRevealSecret } from '../src/reveal.js';

const creatorPublicKey = '07'.repeat(32);
const creatorCommitment = '09'.repeat(32);
const joinerPublicKey = '08'.repeat(32);
const joinerCommitment = '0a'.repeat(32);
const deadlineDaa = 500_000_000n;

function funding(txid, amount = 5_000_000_000n) {
  return { transactionId: txid, index: 0, amount: String(amount), scriptPublicKey: '000051', blockDaaScore: '1', isCoinbase: false };
}

test('client builds a creation transaction locking the exact covenant output', () => {
  const built = buildCreationTx({
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey,
    creatorCommitment,
    side: 'even',
    stakeKas: 1,
    deadlineDaa,
    entries: [funding('b2'.repeat(32))],
    feerate: 1,
    changeScriptPublicKey: '000051',
  });
  const tx = JSON.parse(built.txJson);
  assert.equal(tx.outputs[0].scriptPublicKey, `0000${bytesToHex(built.covenant.p2shScript)}`);
  assert.equal(tx.outputs[0].value, '100000000');
  assert.equal(tx.outputs[0].covenant.covenantId, built.covenantId);
  assert.equal(tx.outputs[0].covenant.authorizingInput, 0);
  assert.equal(built.feeSompi > 0n, true);
});

test('client builds a join transaction with the doubled-pot continuation', () => {
  const creation = { creatorPublicKey, creatorCommitment, side: 'even', stakeKas: 1, deadlineDaa };
  const state0 = deriveCreationCovenant(creation);
  const creationUtxo = {
    transactionId: 'aa'.repeat(32),
    index: 0,
    amount: '100000000',
    scriptPublicKey: `0000${bytesToHex(state0.p2shScript)}`,
    blockDaaScore: '100',
    covenantId: 'cd'.repeat(32),
  };
  const built = buildJoinTx({
    gameId: 'aa'.repeat(32),
    creation,
    joinerAddress: 'kaspatest:joiner',
    joinerPublicKey,
    joinerCommitment,
    creationUtxo,
    entries: [funding('b2'.repeat(32))],
    feeSompi: 4_200_000n,
    changeScriptPublicKey: '000051',
  });
  const joined = deriveJoinedCovenant({ creation, joinerPublicKey, joinerCommitment });
  const tx = JSON.parse(built.txJson);
  assert.equal(tx.outputs[0].scriptPublicKey, `0000${bytesToHex(joined.p2shScript)}`);
  assert.equal(tx.outputs[0].value, '200000000');
  assert.equal(tx.outputs[0].covenant.covenantId, creationUtxo.covenantId);
  assert.equal(built.joinedAddress, joined.address);
  assert.equal(tx.inputs[0].signatureScript.includes(bytesToHex(state0.redeemScript)), true, 'join input must push the current covenant redeem script');
});

test('client creation refuses a covenant that does not match the committed state', () => {
  const built = buildCreationTx({
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey,
    creatorCommitment,
    side: 'even',
    stakeKas: 1,
    deadlineDaa,
    entries: [funding('b2'.repeat(32))],
    feerate: 1,
    changeScriptPublicKey: '000051',
  });
  const wrong = deriveCreationCovenant({ creatorPublicKey, creatorCommitment: '0b'.repeat(32), side: 'even', stakeKas: 1, deadlineDaa });
  assert.notEqual(bytesToHex(wrong.p2shScript), bytesToHex(built.covenant.p2shScript));
});

test('client reveal with a large funding utxo builds exact change without fee substitution', () => {
  const secret = createRevealSecret({ gameId: 'aa'.repeat(32), player: 'kaspatest:joiner', choice: 1, nonceHex: 'ab'.repeat(32) });
  const creation = { creatorPublicKey, creatorCommitment, side: 'even', stakeKas: 1, deadlineDaa };
  const joined = deriveJoinedCovenant({ creation, joinerPublicKey, joinerCommitment });
  const game = {
    gameId: 'aa'.repeat(32),
    confirmationStatus: 'confirmed',
    joinedDaaScore: 100,
    status: 'joined',
    creatorAddress: 'kaspatest:creator',
    joinerAddress: 'kaspatest:joiner',
    players: ['kaspatest:creator', 'kaspatest:joiner'],
    creatorEven: true,
    creatorChoice: 1,
    joinerChoice: 1,
    stakeSompi: 100000000n,
    potSompi: 200000000n,
    deadlineDaa: String(deadlineDaa),
    participants: {
      'kaspatest:creator': { address: 'kaspatest:creator', publicKey: creatorPublicKey, commitment: creatorCommitment, side: 'even' },
      'kaspatest:joiner': { address: 'kaspatest:joiner', publicKey: joinerPublicKey, commitment: secret.commitment, side: 'odd' },
    },
  };
  const gameInput = {
    transactionId: 'aa'.repeat(32),
    index: 0,
    amount: '200000000',
    scriptPublicKey: `0000${bytesToHex(joined.p2shScript)}`,
    redeemScript: bytesToHex(joined.redeemScript),
    covenantId: 'cd'.repeat(32),
  };
  const built = buildRevealTx({
    gameId: 'aa'.repeat(32),
    game,
    caller: 'kaspatest:joiner',
    currentDaaScore: 1000n,
    secret,
    gameInput,
    feeInputs: [funding('b3'.repeat(32), 5_000_000_000n)],
    feeSompi: 4_200_000n,
    changeScriptPublicKey: '000051',
  });
  const tx = JSON.parse(built.txJson);
  const inValue = tx.inputs.reduce((sum, input) => sum + BigInt(input.utxo.amount), 0n);
  const outValue = tx.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  assert.equal(inValue - outValue, 4_200_000n);
  assert.equal(built.feeSompi, 4_200_000n);
});
