import { blake2b256 } from '/blake2b.mjs';

const NETWORK = 'testnet-10';
const FIXED_NONCE = new Uint8Array(32).fill(1);
const FIXED_NONCE_HEX = bytesToHex(FIXED_NONCE);
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);

boot();

async function boot() {
  try {
    const config = await api('/api/config');
    if (config.network !== NETWORK) throw new Error(`Backend must use ${NETWORK}`);
    if (location.pathname === '/game' || location.pathname === '/join') return renderGame(params.get('id') ?? params.get('game'));
    renderHome(config);
  } catch (error) {
    renderBackendError(error.message);
  }
}

function renderHome(config) {
  renderCreate();
}

function renderCreate() {
  app.innerHTML = `<div class="hero"><div class="eyebrow">Private, non-custodial · Kaspa testnet-10</div><h1>Guess even<br>or odd.</h1><p>Pick a side, set your stake. Your friend matches the stake — winner takes the pot.</p></div><form class="card form" id="create-form"><label>Your side</label><div class="choices"><button type="button" class="choice selected" data-side="even">Even</button><button type="button" class="choice" data-side="odd">Odd</button></div><label>Your number</label><div class="number-choices"><button type="button" class="number-choice" data-commit-number="1"><span>1</span><small>odd</small></button><button type="button" class="number-choice" data-commit-number="0"><span>2</span><small>even</small></button></div><label for="stake">Your stake, in KAS</label><input id="stake" type="number" min="1" max="100" step="1" value="1" required><p id="stake-fate" class="fate">You stake 1 KAS. Your friend matches it. Winner takes the pot.</p><div id="create-notice"></div><div class="actions"><button type="submit">Lock it in <span aria-hidden="true">&nbsp;→</span></button></div></form>`;
  let side = 'even';
  let number = null;
  document.querySelectorAll('[data-side]').forEach((button) => button.onclick = () => {
    side = button.dataset.side;
    document.querySelectorAll('[data-side]').forEach((item) => item.classList.toggle('selected', item === button));
  });
  document.querySelectorAll('[data-commit-number]').forEach((button) => button.onclick = () => {
    number = Number(button.dataset.commitNumber);
    document.querySelectorAll('[data-commit-number]').forEach((item) => item.classList.toggle('selected', item === button));
  });
  const stakeInput = document.querySelector('#stake');
  const updateFate = () => {
    const stakeKas = Math.max(1, Math.floor(Number(stakeInput.value) || 1));
    document.querySelector('#stake-fate').textContent = `You stake ${stakeKas} KAS. Your friend matches it. Winner takes ${stakeKas * 2} KAS.`;
  };
  stakeInput.addEventListener('input', updateFate);
  updateFate();
  document.querySelector('#create-form').onsubmit = async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    const stakeKas = Number(document.querySelector('#stake').value);
    if (!Number.isInteger(stakeKas) || stakeKas < 1 || stakeKas > 100) return showNotice('#create-notice', 'Choose a valid stake', 'Enter a whole number from 1 to 100 KAS.', 'error');
    if (number === null) return showNotice('#create-notice', 'Choose your number', 'Pick 1 (odd) or 2 (even) before locking in the game.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKastle('#create-notice');
      rememberAddress(account.address);
      const secret = createRevealSecret(number);
      showNotice('#create-notice', 'Locking it in', 'Reading the network, then it is ready for you to confirm.', '');
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side,
        stakeKas,
      } });
      showNotice('#create-notice', 'Approve in Kastle', `Confirm the ${stakeKas} KAS testnet transaction in your wallet.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      submit.disabled = false;
      showNotice('#create-notice', 'Game was not created', error.message, 'error');
    }
  };
}

function joinSection(game) {
  if (!game.canJoin) return '';
  const yourSide = game.creator?.side === 'even' ? 'odd' : 'even';
  const theirSide = game.creator?.side === 'even' ? 'even' : 'odd';
  const theirStake = game.stakeKas;
  return `<form class="form" id="join-form"><div class="side-banner"><div><small>Your friend took</small><strong>${theirSide === 'even' ? 'Even' : 'Odd'}</strong></div><div><small>Your side</small><strong>${yourSide === 'even' ? 'Even' : 'Odd'}</strong></div></div><p class="fate">Opposite sides only — so the pot always has a single winner. You take ${yourSide === 'even' ? 'Even' : 'Odd'}.</p><p class="number-prompt">Your number</p><div class="number-choices"><button type="button" class="number-choice" data-join-number="1"><span>1</span><small>odd</small></button><button type="button" class="number-choice" data-join-number="0"><span>2</span><small>even</small></button></div><div id="join-notice"><div class="notice"><strong>Choose your number.</strong>You'll match ${escapeHtml(theirStake)} KAS and privately lock in 1 (odd) or 2 (even). Winner takes ${escapeHtml(theirStake * 2)} KAS.</div></div><div class="actions"><button type="submit" disabled>Match the ${escapeHtml(theirStake)} KAS stake <span aria-hidden="true">&nbsp;→</span></button></div></form>`;
}

async function bindJoin(gameId, game) {
  const form = document.querySelector('#join-form');
  if (!form) return;
  const theirStake = game.stakeKas;
  const submit = form.querySelector('button[type="submit"]');
  let number = null;
  document.querySelectorAll('[data-join-number]').forEach((button) => {
    button.onclick = () => {
      number = Number(button.dataset.joinNumber);
      document.querySelectorAll('[data-join-number]').forEach((item) => item.classList.toggle('selected', item === button));
      submit.disabled = false;
    };
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (number === null) return showNotice('#join-notice', 'Choose your number', 'Pick 1 (odd) or 2 (even) before joining.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKastle('#join-notice');
      rememberAddress(account.address);
      const secret = createRevealSecret(number);
      const prepared = await api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
      } });
      showNotice('#join-notice', 'Approve in Kastle', `Match ${theirStake} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      submit.disabled = false;
      showNotice('#join-notice', 'Game was not joined', error.message, 'error');
    }
  };
}

async function renderGame(gameId) {
  if (!isGameId(gameId)) return renderBackendError('Invalid game identifier.');
  scheduleGameRefresh(gameId);
  try {
    paintGame(gameId, await api(`/api/games/${gameId}`));
  } catch (error) {
    renderBackendError(error.message);
  }
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const title = game.status === 'settled' ? winnerTitle(game)
    : game.status === 'first_revealed' ? 'One pick revealed.'
    : game.status === 'joined' ? 'Both stakes are locked.'
    : game.confirmationStatus === 'confirmed' ? 'Waiting on your friend.'
    : 'Locking it in.';
  const action = game.canReveal
    ? '<div id="game-action"><div id="reveal-notice"><div class="notice"><strong>Show your number.</strong>Select the same number you privately locked in: 1 (odd) or 2 (even). Both numbers are added up; the total decides which side wins.</div></div><p class="number-prompt">Your locked number</p><div class="number-choices"><button type="button" class="number-choice" data-reveal-number="1"><span>1</span><small>odd</small></button><button type="button" class="number-choice" data-reveal-number="0"><span>2</span><small>even</small></button></div><div class="actions"><button data-action="reveal" disabled>Reveal with Kastle</button></div></div>'
      : '';
  const safety = game.safetyAction === 'fallback_claim' ? '<div id="game-safety"><div class="notice warn"><strong>Recovery action.</strong>If your friend never reveals, you can claim the whole pot after a five-minute wait.</div><div class="actions"><button class="secondary" data-action="safety">Claim pot</button></div></div>' : '';
  const terminal = game.status === 'fallback_claimed' ? '<div class="notice"><strong>Pot claimed.</strong>You took the pot when your friend went quiet.</div>'
    : game.status === 'refunded' || game.status === 'creator_refunded' ? '<div class="notice"><strong>Refunded.</strong>Your stake was returned.</div>' : '';
  const joinerView = role === 'joiner' || (role === 'viewer' && game.canJoin);
  const actions = joinerView ? joinSection(game) : inviteBox(game);
  app.innerHTML = `<a class="back" href="/">← Exit game</a><div class="hero"><div class="eyebrow">Private game</div><h2>${title}</h2><p>${statusNote(game, role)}</p></div><section class="card game-card">${gameDetails(game)}${actions}${action}${resultOverlay(game)}${safety}${terminal}</section>`;
  await bindJoin(gameId, game);
  const reveal = document.querySelector('[data-action="reveal"]');
  let revealChoice = null;
  document.querySelectorAll('[data-reveal-number]').forEach((button) => button.onclick = () => {
    revealChoice = Number(button.dataset.revealNumber);
    document.querySelectorAll('[data-reveal-number]').forEach((item) => item.classList.toggle('selected', item === button));
    reveal.disabled = false;
  });
  if (reveal) reveal.onclick = async () => {
    reveal.disabled = true;
    try {
      const { provider, account } = await connectKastle('#reveal-notice');
      rememberAddress(account.address);
      if (revealChoice === null) throw new Error('Choose your number first');
      const prepared = await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: revealChoice,
        nonceHex: FIXED_NONCE_HEX,
      } });
      showNotice('#reveal-notice', 'Approve reveal in Kastle', `Network fee: ${formatKas(prepared.feeSompi)} KAS. Your number becomes public after broadcast.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      reveal.disabled = false;
      if (error.code === 'INVALID_REVEAL') {
        revealChoice = null;
        document.querySelectorAll('[data-reveal-number]').forEach((item) => item.classList.remove('selected'));
        showNotice('#reveal-notice', 'Wrong number', 'That number doesn\u2019t match the one you locked in. Select your locked number \u2014 1 (odd) or 2 (even) \u2014 then try again.', 'error');
      } else {
        showNotice('#reveal-notice', 'Reveal was not submitted', error.message, 'error');
      }
    }
  };
  const copy = document.querySelector('[data-action="copy"]');
  if (copy) copy.onclick = async (event) => {
    await navigator.clipboard.writeText(`${location.origin}${game.inviteUrl}`);
    event.target.textContent = 'Copied';
  };
  const safetyButton = document.querySelector('[data-action="safety"]');
  if (safetyButton) safetyButton.onclick = async () => {
    safetyButton.disabled = true;
    try {
      const { provider, account } = await connectKastle('#game-safety');
      const prepared = await api(`/api/games/${gameId}/${game.safetyAction}/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
      } });
      showNotice('#game-safety', 'Approve recovery in Kastle', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/${game.safetyAction}/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      safetyButton.disabled = false;
      showNotice('#game-safety', 'Recovery was not submitted', error.message, 'error');
    }
  };
}

function statusNote(game, role) {
  if (game.status === 'settled') return 'Both picks were revealed and the pot was paid.';
  if (game.status === 'first_revealed') return 'One player revealed their pick. The other can still reveal to settle the pot.';
  if (game.status === 'joined') {
    const yourSide = role === 'creator' ? game.creator?.side : role === 'joiner' ? (game.creator?.side === 'even' ? 'odd' : 'even') : null;
    return yourSide
      ? `Both stakes are locked. Your side is ${yourSide === 'even' ? 'Even' : 'Odd'}. Each of you reveals your locked number to settle the pot.`
      : 'Both stakes are locked. Each player reveals their pick to settle the pot.';
  }
  if (role === 'joiner') return `Your friend staked ${escapeHtml(game.stakeKas)} KAS. You get the other side and match it. Winner takes the pot.`;
  if (game.canJoin) return `Your friend staked ${escapeHtml(game.stakeKas)} KAS. You get the other side and match it. Winner takes the pot.`;
  if (game.confirmationStatus === 'confirmed') return 'Send the invite below. Your friend opens the link to join.';
  return 'The stake is being locked in on Kaspa. The app updates automatically.';
}

function inviteBox(game) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  return `<div class="invite-box"><small>Invite a friend</small><code>${location.origin}${game.inviteUrl}</code><button data-action="copy">Copy invite</button></div>`;
}

function detectRole(game) {
  const address = window.__connectedAddress ?? localStorage.getItem('kaspa-connected-address');
  if (address && game.creator?.address === address) return 'creator';
  if (address && game.joiner?.address === address) return 'joiner';
  return 'viewer';
}

function rememberAddress(address) {
  if (!address) return;
  window.__connectedAddress = address;
  try { localStorage.setItem('kaspa-connected-address', address); } catch { /* ignore */ }
}

function resultOverlay(game) {
  if (game.status !== 'settled') return '';
  return `<div class="result">${resultCopy(game)}${resultPath(game)}</div>`;
}

function winnerTitle(game) {
  const winningSide = winnerSide(game);
  return `${capitalize(winningSide)} took the pot.`;
}

function winnerSide(game) {
  const creatorEven = game.creator?.side === 'even';
  const creatorWon = game.winner === 'creator';
  return creatorWon === creatorEven ? 'even' : 'odd';
}

function resultCopy(game) {
  const winningSide = winnerSide(game);
  return `<small>Outcome</small><strong>${capitalize(winningSide)} won.</strong><span>${shortAddress(game.winnerAddress)}</span>`;
}

function resultPath(game) {
  const creatorEven = game.creator?.side === 'even';
  const creatorWon = game.winner === 'creator';
  const rows = [
    { side: creatorWon ? 'even' : 'odd', label: 'Creator', address: game.creator?.address, won: creatorWon },
    { side: creatorEven ? 'odd' : 'even', label: 'Joiner', address: game.joiner?.address, won: !creatorWon },
  ];
  return `<div class="result-path">${rows.map((player) => {
    const address = player.address ? shortAddress(player.address) : '—';
    return `<div class="result-player ${player.won ? 'won' : 'lost'}"><small>${player.won ? 'Won' : 'Lost'}</small><strong>${player.label}</strong><span>${address}</span></div>`;
  }).join('')}</div>`;
}

function capitalize(word) { return word.charAt(0).toUpperCase() + word.slice(1); }

function shortAddress(address) {
  if (!address) return '—';
  const tail = address.slice(-8);
  return `…${tail}`;
}

function scheduleGameRefresh(gameId) {
  const settled = ['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(window.__gameStatus);
  if (!window.__gameRefreshStarted) {
    window.__gameRefreshStarted = true;
    setInterval(() => { void refreshGame(gameId); }, 3500);
  }
  window.__gameStatus = undefined;
}

async function refreshGame(gameId) {
  try {
    if (!(location.pathname === '/game' || location.pathname === '/join')) return;
    if ((params.get('id') ?? params.get('game')) !== gameId) return;
    const game = await api(`/api/games/${gameId}`);
    if (window.__gameStatus === game.status) return;
    window.__gameStatus = game.status;
    await paintGame(gameId, game);
  } catch {
    // A transient refresh may race a broadcast; the next tick retries.
  }
}

async function connectKastle(selector) {
  const provider = globalThis.kastle ?? globalThis.kastleWallet;
  if (!provider) throw new Error('Kastle wallet extension is required');
  showNotice(selector, 'Connecting to Kastle', 'Confirm the connection in your wallet.', '');
  if (await provider.connect() === false) throw new Error('Kastle connection was not approved');
  const [account, network] = await Promise.all([provider.getAccount(), provider.getNetwork()]);
  if (network !== NETWORK) throw new Error(`Switch Kastle to ${NETWORK}`);
  if (!account?.address?.startsWith('kaspatest:') || !/^[0-9a-f]{64}$|^(02|03)[0-9a-f]{64}$/i.test(account?.publicKey ?? '')) throw new Error('Kastle did not return a valid testnet account');
  account.publicKey = account.publicKey.length === 66 ? account.publicKey.slice(2) : account.publicKey;
  if (typeof provider.signTx !== 'function') throw new Error('Kastle transaction signing is unavailable');
  return { provider, account };
}

function createRevealSecret(choice) {
  const preimage = new Uint8Array(40);
  preimage[0] = choice;
  preimage.set(FIXED_NONCE, 8);
  return { choice, nonceHex: FIXED_NONCE_HEX, commitment: bytesToHex(blake2b256(preimage)) };
}

function gameDetails(game) {
  return `<div class="details"><div class="detail"><small>Stake</small><span>${escapeHtml(game.stakeKas)} KAS</span></div><div class="detail"><small>Pot</small><span>${escapeHtml(game.stakeKas * 2)} KAS</span></div><div class="detail"><small>Creator took</small><span class="capitalize">${escapeHtml(game.creator.side)}</span></div><div class="detail"><small>Network</small><span>${escapeHtml(game.network)}</span></div></div>`;
}

function renderBackendError(message) {
  app.innerHTML = `<a class="back" href="/">← Back</a><section class="card"><div class="notice error"><strong>Testnet backend unavailable.</strong>${escapeHtml(message)}</div></section>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? 'Backend request failed');
    error.code = body.error;
    throw error;
  }
  return body;
}
function showNotice(selector, title, message, kind) {
  const node = document.querySelector(selector);
  if (node) node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div>`;
}

function isGameId(value) { return /^[0-9a-f]{64}$/i.test(value ?? ''); }
function bytesToHex(value) { return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
