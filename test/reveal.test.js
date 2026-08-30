import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalRevealPreimage,
  createRevealSecret,
  loadRevealSecret,
  MemoryRevealStore,
  parityOutcome,
  REVEAL_COPY,
  revealActionView,
  revealCommitment,
  resolveReveal,
  saveRevealSecret,
  verifyRevealPreimage,
} from '../src/reveal.js';

const gameId = 'aa'.repeat(32);
const creatorSecret = createRevealSecret({ gameId, player: 'creator', choice: 1, nonce: new Uint8Array(32).fill(7) });
const joinerSecret = createRevealSecret({ gameId, player: 'joiner', choice: 0, nonce: new Uint8Array(32).fill(8) });
const game = {
  gameId,
  confirmationStatus: 'confirmed',
  joinedDaaScore: 1_000n,
  currentDaaScore: 1_001n,
  participants: {
    creator: { commitment: creatorSecret.commitment, scriptPublicKey: '000051' },
    joiner: { commitment: joinerSecret.commitment, scriptPublicKey: '000052' },
  },
};

test('uses deterministic canonical reveal vectors', () => {
  assert.equal(Buffer.from(canonicalRevealPreimage({ choice: 1, nonce: new Uint8Array(32).fill(7) })).toString('hex'), '0100000000000000' + '07'.repeat(32));
  assert.equal(creatorSecret.commitment, '3fae7ec17516ad90844e59fcd4ddd3291ae7615c67d9659b5227695448584e88');
  assert.equal(revealCommitment({ choice: 1, nonceHex: '07'.repeat(32) }), creatorSecret.commitment);
  assert.equal(verifyRevealPreimage({ commitment: creatorSecret.commitment, choice: 1, nonceHex: '07'.repeat(32) }), true);
  assert.equal(verifyRevealPreimage({ commitment: creatorSecret.commitment, choice: 0, nonceHex: '07'.repeat(32) }), false);
});

test('resolves reveal readiness and invalid local values without marking them revealed', () => {
  assert.equal(resolveReveal({ game: { ...game, currentDaaScore: 1_000n }, caller: 'creator', secret: creatorSecret }).message, REVEAL_COPY.waitingForLocks);
  assert.equal(resolveReveal({ game, caller: 'creator', secret: null }).status, 'missing_secret');
  assert.equal(resolveReveal({ game, caller: 'observer', secret: creatorSecret }).message, REVEAL_COPY.notPlayer);
  assert.deepEqual(resolveReveal({ game, caller: 'creator', secret: creatorSecret }), {
    status: 'available',
    available: true,
    message: REVEAL_COPY.available,
    action: 'reveal',
    player: 'creator',
    choice: 1,
    nonceHex: '07'.repeat(32),
    fallbackDeadlineDaa: 4_001n,
  });
  assert.equal(resolveReveal({ game, caller: 'creator', secret: { ...creatorSecret, choice: 0 } }).status, 'invalid');
});

test('projects reveal states for the browser without choosing the winner', () => {
  assert.deepEqual(revealActionView(resolveReveal({ game, caller: 'creator', secret: creatorSecret })), {
    action: 'reveal',
    state: 'available',
    canSubmit: true,
    message: REVEAL_COPY.available,
    fallbackDeadlineDaa: 4_001n,
  });
  assert.equal(revealActionView(resolveReveal({ game: { ...game, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n } }, caller: 'creator', secret: creatorSecret })).state, 'waiting_for_other_player');
  assert.equal(parityOutcome({ creatorChoice: 1, joinerChoice: 0, creatorEven: true }), 'joiner');
  assert.equal(parityOutcome({ creatorChoice: 1, joinerChoice: 0, creatorEven: false }), 'creator');
});

test('stores reveal secrets through the local storage boundary', async () => {
  const store = new MemoryRevealStore();
  await saveRevealSecret(store, creatorSecret);
  assert.deepEqual(await loadRevealSecret(store, { gameId, player: 'creator' }), creatorSecret);
});
