import { blake2b256 } from '/blake2b.mjs';

const NETWORK = 'testnet-10';
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
let selectedSide = 'even';

boot();

async function boot() {
  try {
    const config = await api('/api/config');
    if (config.network !== NETWORK) throw new Error(`Backend must use ${NETWORK}`);
    if (location.pathname === '/game') return renderGame(params.get('id'));
    if (location.pathname === '/join') return renderJoin(params.get('game'));
    renderHome(config);
  } catch (error) {
    renderBackendError(error.message);
  }
}

function renderHome(config) {
  app.innerHTML = `<section class="hero"><div class="eyebrow">Connected to Kaspa testnet-10</div><h1>Let chance<br>choose.</h1><p>Even or Odd is a non-custodial testnet game with direct private invites.</p></section><section class="grid"><article class="card"><div class="eyebrow">Player A</div><h3>Make the first move.</h3><p>Choose a side and stake, then sign the game deposit with Kastle.</p><button data-action="create">Start a game <span aria-hidden="true">&nbsp;→</span></button></article><article class="card"><div class="eyebrow">Player B</div><h3>Have an invite?</h3><p>Open the link, match Player A's stake, and privately commit your number.</p><form id="invite-form"><input id="invite" type="url" placeholder="Paste your invite" required><button type="submit">Open invite <span aria-hidden="true">&nbsp;→</span></button></form></article></section>`;
  document.querySelector('[data-action="create"]').onclick = renderCreate;
  document.querySelector('#invite-form').onsubmit = (event) => {
    event.preventDefault();
    openInvite(document.querySelector('#invite').value);
  };
}

function renderCreate() {
  app.innerHTML = `<a class="back" href="/">← Back</a><div class="hero"><div class="eyebrow">Player A · testnet-10</div><h2>Set the terms.</h2><p>The backend prepares the covenant from live testnet UTXOs and fee data. Kastle signs it without sharing your key.</p></div><form class="card form" id="create-form"><label>Choose your side</label><div class="choices"><button type="button" class="choice selected" data-side="even">Even</button><button type="button" class="choice" data-side="odd">Odd</button></div><label>Privately commit your number</label><div class="choices"><button type="button" class="choice selected" data-number="0">0 · Even</button><button type="button" class="choice" data-number="1">1 · Odd</button></div><label for="stake">Your stake, in KAS</label><input id="stake" type="number" min="1" max="100" step="1" value="1" required><div id="create-notice"></div><div class="actions"><button type="submit">Prepare with backend <span aria-hidden="true">&nbsp;→</span></button></div></form>`;
  let number = 0;
  document.querySelectorAll('[data-side]').forEach((button) => button.onclick = () => {
    selectedSide = button.dataset.side;
    document.querySelectorAll('[data-side]').forEach((item) => item.classList.toggle('selected', item === button));
  });
  document.querySelectorAll('[data-number]').forEach((button) => button.onclick = () => {
    number = Number(button.dataset.number);
    document.querySelectorAll('[data-number]').forEach((item) => item.classList.toggle('selected', item === button));
  });
  document.querySelector('#create-form').onsubmit = async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    const stakeKas = Number(document.querySelector('#stake').value);
    if (!Number.isInteger(stakeKas) || stakeKas < 1 || stakeKas > 100) return showNotice('#create-notice', 'Choose a valid stake', 'Enter a whole number from 1 to 100 KAS.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKastle('#create-notice');
      const secret = createRevealSecret(number);
      showNotice('#create-notice', 'Preparing transaction', 'The backend is reading live testnet-10 UTXOs and fee estimates.', '');
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side: selectedSide,
        stakeKas,
      } });
      showNotice('#create-notice', 'Approve in Kastle', `Confirm the ${stakeKas} KAS testnet transaction in your wallet.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await saveRevealSecret(game.gameId, account.address, secret);
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      submit.disabled = false;
      showNotice('#create-notice', 'Game was not created', error.message, 'error');
    }
  };
}

async function renderJoin(gameId) {
  app.innerHTML = `<a class="back" href="/">← Back</a><div class="hero"><div class="eyebrow">Player B · testnet-10</div><h2>Match the game.</h2><p>Verify Player A's terms, choose your number privately, and match the stake with Kastle.</p></div><section class="card" id="join-card"><div class="notice"><strong>Checking Kaspa</strong>Waiting for the backend.</div></section>`;
  if (!isGameId(gameId)) return showJoinError('Invite is not valid.', 'An invite must contain a 32-byte game transaction identifier.');
  try {
    const game = await api(`/api/games/${gameId}`);
    if (!game.canJoin) {
      const message = game.status === 'joined' ? 'Another player has already joined.' : 'This game is not ready to join.';
      document.querySelector('#join-card').innerHTML = `${gameDetails(game)}<div class="notice warn"><strong>Joining unavailable.</strong>${message}</div>`;
      return;
    }
    document.querySelector('#join-card').innerHTML = `${gameDetails(game)}<form class="form" id="join-form"><label>Player B's private commitment</label><p class="number-prompt">Choose the vote you will reveal later</p><div class="number-choices"><button type="button" class="number-choice" data-join-number="0"><span>0</span><small>Even</small></button><button type="button" class="number-choice" data-join-number="1"><span>1</span><small>Odd</small></button></div><div id="join-notice"><div class="notice"><strong>Deposit accepted by Kaspa.</strong>Your vote is committed privately when you match ${escapeHtml(game.stakeKas)} KAS plus the network fee.</div></div><div class="actions"><button type="submit" disabled>Commit vote & match stake <span aria-hidden="true">&nbsp;→</span></button></div></form>`;
    let choice = null;
    const joinSubmit = document.querySelector('#join-form button[type="submit"]');
    document.querySelectorAll('[data-join-number]').forEach((button) => button.onclick = () => {
      choice = Number(button.dataset.joinNumber);
      document.querySelectorAll('[data-join-number]').forEach((item) => item.classList.toggle('selected', item === button));
      joinSubmit.disabled = false;
    });
    document.querySelector('#join-form').onsubmit = async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      if (choice === null) return;
      submit.disabled = true;
      try {
        const { provider, account } = await connectKastle('#join-notice');
        const secret = createRevealSecret(choice);
        const prepared = await api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
          joinerAddress: account.address,
          joinerPublicKey: account.publicKey,
          joinerCommitment: secret.commitment,
        } });
        await saveRevealSecret(gameId, account.address, secret);
        showNotice('#join-notice', 'Approve in Kastle', `Match ${game.stakeKas} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
        const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
        if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
        await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
        location.href = `/game?id=${gameId}`;
      } catch (error) {
        submit.disabled = false;
        showNotice('#join-notice', 'Game was not joined', error.message, 'error');
      }
    };
  } catch (error) {
    showJoinError('Game unavailable.', error.message);
  }
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
  const confirmation = game.confirmationStatus === 'confirmed'
    ? '<strong>Deposit accepted by Kaspa.</strong>The transaction was found and Kaspa advanced beyond it.'
    : '<strong>Waiting for Kaspa.</strong>The app will update automatically.';
  const title = game.status === 'settled' ? winnerTitle(game)
    : game.status === 'first_revealed' ? 'One player revealed.'
    : game.status === 'joined' ? 'Both stakes are locked.'
    : game.confirmationStatus === 'confirmed' ? 'Ready for Player B.' : 'Confirming deposit.';
  const action = game.canReveal
    ? '<div id="game-action"><div class="notice"><strong>Vote again to reveal.</strong>Select the same private vote you committed, then connect the Kastle account used for this game.</div><p class="number-prompt">Confirm your committed vote</p><div class="number-choices"><button type="button" class="number-choice" data-reveal-number="0"><span>0</span><small>Even</small></button><button type="button" class="number-choice" data-reveal-number="1"><span>1</span><small>Odd</small></button></div><div class="actions"><button data-action="reveal" disabled>Vote & reveal with Kastle</button></div></div>'
      : '';
  const safety = game.safetyAction === 'fallback_claim' ? '<div id="game-safety"><div class="notice warn"><strong>Recovery action.</strong>The first revealer can claim the pot after the five-minute DAA wait.</div><div class="actions"><button class="secondary" data-action="safety">Claim timeout pot</button></div></div>' : '';
  const terminal = game.status === 'fallback_claimed' ? '<div class="notice"><strong>Timeout claim confirmed.</strong>The first revealer received the pot.</div>'
    : game.status === 'refunded' || game.status === 'creator_refunded' ? '<div class="notice"><strong>Refund complete.</strong>The covenant returned the available stake.</div>' : '';
  app.innerHTML = `<a class="back" href="/">← Exit game</a><div class="hero"><div class="eyebrow">Private game · testnet-10</div><h2>${title}</h2><p>The backend verifies this game directly against Kaspa testnet-10.</p></div><section class="card game-card">${gameDetails(game)}${inviteBox(game)}${action}${resultOverlay(game)}${safety}${terminal}</section>`;
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
      const { provider, account } = await connectKastle('#game-action');
      const secret = await loadRevealSecret(gameId, account.address);
      if (!secret) throw new Error('This browser does not have the reveal secret for the connected player');
      if (revealChoice !== secret.choice) throw new Error('Your reveal vote must match the vote you committed earlier');
      const prepared = await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: revealChoice,
        nonceHex: secret.nonceHex,
      } });
      showNotice('#game-action', 'Approve reveal in Kastle', `Network fee: ${formatKas(prepared.feeSompi)} KAS. Your hidden number becomes public after broadcast.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      reveal.disabled = false;
      showNotice('#game-action', 'Reveal was not submitted', error.message, 'error');
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

function inviteBox(game) {
  return `<div class="invite-box"><small>Private invite</small><code>${location.origin}${game.inviteUrl}</code><button data-action="copy">Copy invite</button></div><div class="notice ${game.confirmationStatus === 'confirmed' ? '' : 'warn'}">${
    game.confirmationStatus === 'confirmed'
      ? '<strong>Deposit accepted by Kaspa.</strong>The transaction was found and Kaspa advanced beyond it.'
      : '<strong>Waiting for Kaspa.</strong>The app will update automatically.'
  }</div>`;
}

function resultOverlay(game) {
  if (game.status !== 'settled') return '';
  return `<div class="result">${resultCopy(game)}${resultPath(game)}</div>`;
}

function winnerTitle(game) {
  const winnerName = game.winner === 'creator' ? 'Player A' : 'Player B';
  return `${winnerName} took the pot.`;
}

function resultCopy(game) {
  const winner = game.winner === 'creator' ? { label: 'Player A', address: game.creator.address } : { label: 'Player B', address: game.joiner?.address };
  if (!winner.address) return '<small>Outcome</small><strong>The pot was paid.</strong>';
  return `<small>Outcome</small><strong>${winner.label} won.</strong><span>${shortAddress(winner.address)}</span>`;
}

function resultPath(game) {
  const winnerRole = game.winner === 'creator' ? 'creator' : 'joiner';
  const players = [
    { role: 'creator', label: 'Player A', address: game.creator?.address },
    { role: 'joiner', label: 'Player B', address: game.joiner?.address },
  ];
  return `<div class="result-path">${players.map((player) => {
    const isWinner = player.role === winnerRole;
    const address = player.address ? shortAddress(player.address) : '—';
    return `<div class="result-player ${isWinner ? 'won' : 'lost'}"><small>${isWinner ? 'Won' : 'Lost'}</small><strong>${player.label}</strong><span>${address}</span></div>`;
  }).join('')}</div>`;
}

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
    if (location.pathname !== '/game' || params.get('id') !== gameId) return;
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
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const preimage = new Uint8Array(40);
  preimage[0] = choice;
  preimage.set(nonce, 8);
  return { choice, nonceHex: bytesToHex(nonce), commitment: bytesToHex(blake2b256(preimage)) };
}

async function saveRevealSecret(gameId, player, secret) {
  const database = await openSecretDatabase();
  await new Promise((resolve, reject) => {
    const request = database.transaction('reveal-secrets', 'readwrite').objectStore('reveal-secrets').put({ key: `${gameId}:${player}`, gameId, player, ...secret });
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

async function loadRevealSecret(gameId, player) {
  const database = await openSecretDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction('reveal-secrets', 'readonly').objectStore('reveal-secrets').get(`${gameId}:${player}`);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function openSecretDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kaspa-even-odd', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('reveal-secrets')) request.result.createObjectStore('reveal-secrets', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function gameDetails(game) {
  return `<div class="details"><div class="detail"><small>Game</small><span>${escapeHtml(game.gameId)}</span></div><div class="detail"><small>Stake</small><span>${escapeHtml(game.stakeKas)} KAS</span></div><div class="detail"><small>Network</small><span>${escapeHtml(game.network)}</span></div><div class="detail"><small>Player A side</small><span>${escapeHtml(game.creator.side)}</span></div></div>`;
}

function renderBackendError(message) {
  app.innerHTML = `<a class="back" href="/">← Back</a><section class="card"><div class="notice error"><strong>Testnet backend unavailable.</strong>${escapeHtml(message)}</div></section>`;
}

function showJoinError(title, message) {
  const card = document.querySelector('#join-card');
  if (card) card.innerHTML = `<div class="notice error"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div><div class="actions"><a class="button secondary" href="/">Return home</a></div>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error ?? 'Backend request failed');
  return body;
}

function openInvite(value) {
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/join' || url.searchParams.get('v') !== 'EO/v2' || !isGameId(url.searchParams.get('game'))) throw new Error('Invite is not trusted or supported.');
    location.href = `/join?v=EO%2Fv2&game=${url.searchParams.get('game').toLowerCase()}`;
  } catch (error) {
    alert(error.message);
  }
}

function showNotice(selector, title, message, kind) {
  const node = document.querySelector(selector);
  if (node) node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div>`;
}

function isGameId(value) { return /^[0-9a-f]{64}$/i.test(value ?? ''); }
function bytesToHex(value) { return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
