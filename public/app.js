import { blake2b256 } from '/blake2b.mjs';

const NETWORK = 'testnet-10';
const FIXED_NONCE = new Uint8Array(32).fill(1);
const FIXED_NONCE_HEX = bytesToHex(FIXED_NONCE);
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const KASTLE_DOWNLOAD = 'https://kastle.app';

boot();

async function boot() {
  try {
    const config = await api('/api/config');
    if (config.network !== NETWORK) throw new Error(`Backend must use ${NETWORK}`);
    if (location.pathname === '/game' || location.pathname === '/join') return renderGame(params.get('id') ?? params.get('game'));
    renderCreate();
  } catch (error) {
    renderBackendError(error.message);
  }
}

function renderCreate() {
  app.innerHTML = `
    <section class="panel" aria-label="Start a game">
      <div class="panel-head">
        <h1>Even / Odd</h1>
      </div>
      <form class="form" id="create-form">
        <fieldset class="choice-group">
          <legend>Your side</legend>
          <div class="choice-row">
            <button type="button" class="choice selected" data-side="even" aria-pressed="true">Even</button>
            <button type="button" class="choice" data-side="odd" aria-pressed="false">Odd</button>
          </div>
        </fieldset>
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num" data-commit-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
            <button type="button" class="choice num" data-commit-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
          </div>
        </fieldset>
        <div class="stake-block">
          <div class="stake-label-row">
            <label for="stake">Your stake (KAS)</label>
          </div>
          <input id="stake" type="number" min="1" max="100" step="1" value="1" aria-label="Stake in KAS" class="stake-input">
          <p class="fate">Winner takes the pot &mdash; <span id="stake-fate">2 KAS</span>.</p>
        </div>
        <div id="create-notice"></div>
        <div class="actions">
          <button type="submit" class="primary" id="create-submit">Play for 1 KAS</button>
        </div>
      </form>
    </section>`;

  let side = 'even';
  let number = null;

  document.querySelectorAll('[data-side]').forEach((button) => {
    button.addEventListener('click', () => {
      side = button.dataset.side;
      document.querySelectorAll('[data-side]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
    });
  });
  document.querySelectorAll('[data-commit-number]').forEach((button) => {
    button.addEventListener('click', () => {
      number = Number(button.dataset.commitNumber);
      document.querySelectorAll('[data-commit-number]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
    });
  });

  const stakeInput = document.querySelector('#stake');
  const stakeFate = document.querySelector('#stake-fate');
  const submit = document.querySelector('#create-submit');

  const stakeState = () => {
    const raw = Math.floor(Number(stakeInput.value) || 1);
    const stake = Math.min(100, Math.max(1, raw));
    return stake;
  };
  const syncStake = () => {
    const stake = stakeState();
    submit.textContent = `Play for ${stake} KAS`;
    stakeFate.textContent = `${stake * 2} KAS`;
  };
  stakeInput.addEventListener('input', syncStake);
  syncStake();

  document.querySelector('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const stake = stakeState();
    if (!Number.isInteger(Number(stakeInput.value)) || Number(stakeInput.value) < 1 || Number(stakeInput.value) > 100) {
      return showNotice('#create-notice', 'Enter a stake', 'Use a whole number from 1 to 100 KAS.', 'error');
    }
    if (number === null) return showNotice('#create-notice', 'Pick a number', 'Choose 1 or 2 before you play.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKastle('#create-notice');
      rememberAddress(account.address);
      const secret = createRevealSecret(number);
      showNotice('#create-notice', 'Reading the network', '', '');
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side,
        stakeKas: stake,
      } });
      showNotice('#create-notice', 'Confirm in Kastle', `Approve the ${stake} KAS testnet transaction.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await waitForGameConfirmation(game.gameId, stake);
    } catch (error) {
      submit.disabled = false;
      showNotice('#create-notice', 'Game was not created', error.message, 'error');
    }
  });
}

async function waitForGameConfirmation(gameId, stakeKas) {
  const confirmBox = document.querySelector('#confirm-box');
  const box = confirmBox ?? document.createElement('div');
  box.id = 'confirm-box';
  box.className = 'confirm-banner';
  box.innerHTML = `
    <div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><span class="confirm-title">Locking it in &mdash; confirming your ${escapeHtml(stakeKas)} KAS stake</span></div>`;
  if (!confirmBox) {
    const form = document.querySelector('#create-form');
    form.prepend(box);
  }
  document.querySelector('#create-submit').disabled = true;
  try {
    while (true) {
      const status = await api(`/api/games/${gameId}`);
      if (status.status === 'waiting_for_player_b') {
        location.href = `/game?id=${gameId}`;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  } catch (error) {
    box.remove();
    renderBackendError(error.message);
  }
}

function joinSection(game, yourSide) {
  if (!game.canJoin) return '';
  const theirStake = game.stakeKas;
  return `
    <div class="hero-card" id="join-card">
      <p class="lead">You're <strong class="side-strong">${capitalize(yourSide)}</strong>.</p>
      <form class="form" id="join-form">
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num" data-join-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
            <button type="button" class="choice num" data-join-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
          </div>
        </fieldset>
        <p class="fate">Stake ${escapeHtml(theirStake)} KAS. Winner takes ${escapeHtml(theirStake * 2)} KAS.</p>
        <div id="join-notice"></div>
        <div class="actions">
          <button type="submit" class="primary" id="join-submit" disabled>Join for ${escapeHtml(theirStake)} KAS</button>
        </div>
      </form>
    </div>`;
}

async function bindJoin(gameId, game) {
  const form = document.querySelector('#join-form');
  if (!form) return;
  const theirStake = game.stakeKas;
  const submit = form.querySelector('button[type="submit"]');
  let number = null;
  document.querySelectorAll('[data-join-number]').forEach((button) => {
    button.addEventListener('click', () => {
      number = Number(button.dataset.joinNumber);
      document.querySelectorAll('[data-join-number]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      submit.disabled = false;
    });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (number === null) return showNotice('#join-notice', 'Pick a number', 'Choose 1 or 2 before you join.', 'error');
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
      showNotice('#join-notice', 'Confirm in Kastle', `Match ${theirStake} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      submit.disabled = false;
      showNotice('#join-notice', error.message, '', 'error');
    }
  });
}

async function renderGame(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  scheduleGameRefresh(gameId);
  try {
    paintGame(gameId, await api(`/api/games/${gameId}`));
  } catch (error) {
    renderBackendError(error.message);
  }
}

function paintGameHeader(status, role, game) {
  if (status === 'settled') {
    const won = winnerIsYou(game, role);
    return { title: won ? 'You won.' : game.winner === 'creator' ? `${capitalize(game.creator?.side)} took it.` : 'Game over.', loading: false };
  }
  if (role === 'creator' && game.status === 'waiting_for_player_b') return { title: 'Your game is ready.', loading: false };
  if (game.status === 'joined' || game.status === 'first_revealed' || game.status === 'reveal_broadcast' || game.status === 'settlement_broadcast') return { title: "It's on.", loading: false };
  if (game.canJoin) return { title: "You're in.", loading: false };
  return { title: 'Locking it in.', loading: true };
}

async function paintGame(gameId, game) {
  const role = detectRole(game);
  const yourSide = role === 'creator' ? game.creator?.side : role === 'joiner' ? (game.creator?.side === 'even' ? 'odd' : 'even') : null;
  const header = paintGameHeader(game.status, role, game);
  const joinerView = role === 'joiner' || (role === 'viewer' && game.canJoin);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  const revealMine = game.canReveal && (role === 'creator' || role === 'joiner') && !isMyReveal(game, role);
  const waiting = active && !joinerView && !revealMine;

  app.innerHTML = `
    <a class="back" href="/">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head">
        ${header.loading ? '<div class="header-loading"><span class="spinner large confirm" aria-hidden="true"></span><h2>Locking it in</h2></div>' : `<h2>${header.title}</h2>`}
      </div>
      <div class="game-body">
        ${gameDetails(game)}
        ${active ? (joinerView ? joinSection(game, yourSide ?? (game.creator?.side === 'even' ? 'odd' : 'even')) : '') + inviteBox(game, waiting) + (revealMine ? revealSection(game, role) : '') : ''}
        ${resultOverlay(game, role)}
        ${safetySection(game)}
        ${terminalSection(game)}
      </div>
    </section>`;

  await bindJoin(gameId, game);
  bindReveal(gameId);
  bindShare();
  bindSafety(gameId, game);
  bindPlayAgain();
}

function inviteBox(game, waiting) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  const waitingRow = waiting
    ? '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for your friend</span></div>'
    : '';
  return `
    <div class="invite-box" id="invite-box">
      ${waitingRow}
      <button class="share-button" data-action="copy-link">Copy link</button>
    </div>`;
}

function gameDetails(game) {
  const amount = game.stakeKas;
  const pot = game.stakeKas * 2;
  return `
    <div class="summary">
      <div class="sum-item"><small>Stake</small><strong>${escapeHtml(amount)} KAS</strong></div>
      <div class="sum-item"><small>Pot</small><strong>${escapeHtml(pot)} KAS</strong></div>
    </div>`;
}

function revealSection(game, role) {
  return `
    <div id="game-action" class="reveal-block">
      <p class="lead">Reveal your number</p>
      <div id="reveal-notice"></div>
      <div class="choice-row">
        <button type="button" class="choice num" data-reveal-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
        <button type="button" class="choice num" data-reveal-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
      </div>
      <div class="actions"><button type="button" class="primary" data-action="reveal" disabled>Reveal number</button></div>
    </div>`;
}

function isMyReveal(game, role) {
  if (role !== 'creator' && role !== 'joiner') return false;
  return game.revealedPicks?.[role] !== undefined;
}

function bindReveal(gameId) {
  const reveal = document.querySelector('[data-action="reveal"]');
  if (!reveal) return;
  let revealChoice = null;
  document.querySelectorAll('[data-reveal-number]').forEach((button) => {
    button.addEventListener('click', () => {
      revealChoice = Number(button.dataset.revealNumber);
      document.querySelectorAll('[data-reveal-number]').forEach((item) => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      reveal.disabled = false;
    });
  });
  reveal.addEventListener('click', async () => {
    reveal.disabled = true;
    try {
      const { provider, account } = await connectKastle('#reveal-notice');
      rememberAddress(account.address);
      if (revealChoice === null) { throw new Error('Pick your number first'); }
      const prepared = await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: revealChoice,
        nonceHex: FIXED_NONCE_HEX,
      } });
      showNotice('#reveal-notice', 'Confirm in Kastle', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      reveal.disabled = false;
      if (error.code === 'INVALID_REVEAL') {
        revealChoice = null;
        document.querySelectorAll('[data-reveal-number]').forEach((item) => {
          item.classList.remove('selected');
          item.setAttribute('aria-pressed', 'false');
        });
        showNotice('#reveal-notice', 'That was the wrong number', 'Pick the number you locked in at the start, then try again.', 'error');
      } else {
        showNotice('#reveal-notice', error.message, '', 'error');
      }
    }
  });
}

function bindShare() {
  const url = location.href;
  const copy = document.querySelector('[data-action="copy-link"]');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await copyLink(url);
        flashCopy(copy);
      } catch { /* ignore */ }
    });
  }
}

async function copyLink(url) {
  await navigator.clipboard.writeText(url);
}

function flashCopy(button) {
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1600);
}

function safetySection(game) {
  if (game.safetyAction === 'fallback_claim' && game.status === 'first_revealed') {
    return `
      <div id="game-safety" class="safety">
        <p class="lead">If your friend never reveals</p>
        <p class="muted-note">You can claim the whole pot after the wait.</p>
        <div class="actions"><button type="button" class="outline" data-action="safety">Claim pot</button></div>
      </div>`;
  }
  if (game.safetyAction === 'creator_refund' && game.status === 'waiting_for_player_b') {
    return `
      <div id="game-safety" class="safety">
        <div class="actions"><button type="button" class="outline" data-action="safety">Cancel game</button></div>
      </div>`;
  }
  return '';
}

function terminalSection(game) {
  if (game.status === 'fallback_claimed') return '<div class="notice"><strong>Pot claimed.</strong>Your friend never revealed, so you took the pot.</div>';
  if (game.status === 'refunded' || game.status === 'creator_refunded') return '<div class="notice"><strong>Canceled.</strong>Your stake was returned.</div>';
  return '';
}

function bindSafety(gameId, game) {
  const safetyButton = document.querySelector('[data-action="safety"]');
  if (!safetyButton) return;
  safetyButton.addEventListener('click', async () => {
    safetyButton.disabled = true;
    try {
      const { provider, account } = await connectKastle('#game-safety');
      const prepared = await api(`/api/games/${gameId}/${game.safetyAction}/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
      } });
      showNotice('#game-safety', 'Confirm in Kastle', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await provider.signTx(NETWORK, prepared.txJson);
      if (!signedTxJson) throw new Error('Kastle did not return a signed transaction');
      await api(`/api/games/${gameId}/${game.safetyAction}/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      safetyButton.disabled = false;
      showNotice('#game-safety', error.message, '', 'error');
    }
  });
}

function winnerIsYou(game, role) {
  if (role !== 'creator' && role !== 'joiner') return false;
  return game.winner === role;
}

function resultOverlay(game, role) {
  if (game.status !== 'settled') return '';
  const won = winnerIsYou(game, role);
  const creatorEven = game.creator?.side === 'even';
  const creatorPick = game.revealedPicks?.creator === undefined ? '\u00b7' : game.revealedPicks.creator;
  const joinerPick = game.revealedPicks?.joiner === undefined ? '\u00b7' : game.revealedPicks.joiner;
  const resultTitle = role === 'creator' || role === 'joiner'
    ? `${won ? 'You won ' : 'You lost '}<strong>${escapeHtml(game.stakeKas * 2)} KAS</strong>.`
    : `<strong>${capitalize(winnerSideName(game))}</strong> took the pot.`;
  return `
    <div class="result ${won ? 'winner' : 'loser'}">
      <p class="result-title">${resultTitle}</p>
      <div class="result-side">
        <span class="result-side-name">Creator &middot; ${capitalize(game.creator?.side)}</span>
        <span class="result-pick">${creatorPick}</span>
      </div>
      <div class="result-side">
        <span class="result-side-name">Joiner &middot; ${capitalize(game.creator?.side === 'even' ? 'odd' : 'even')}</span>
        <span class="result-pick">${joinerPick}</span>
      </div>
      ${role === 'creator' || role === 'joiner' ? '<button type="button" class="primary" data-action="play-again">Play again</button>' : ''}
    </div>`;
}

function winnerSideName(game) {
  return game.winner === 'creator' ? (game.creator?.side === 'even' ? 'Even' : 'Odd') : (game.creator?.side === 'even' ? 'Odd' : 'Even');
}

function bindPlayAgain() {
  const again = document.querySelector('[data-action="play-again"]');
  if (again) again.addEventListener('click', () => { location.href = '/'; });
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

function capitalize(word) { return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''; }

function scheduleGameRefresh(gameId) {
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
  if (!provider) {
    showNotice(selector, 'Install Kastle to play', 'Even/Odd uses the Kastle wallet.', 'error');
    throw new Error(`Kastle wallet extension is required. Get it at ${KASTLE_DOWNLOAD}`);
  }
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

function renderBackendError(message) {
  app.innerHTML = `<a class="back" href="/">Exit</a><section class="panel"><p class="lead">Something went wrong.</p><div class="notice error"><strong>${escapeHtml(message)}</strong></div></section>`;
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
  if (!node) return;
  const body = message ? escapeHtml(message) : '';
  node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong>${body}</div>`;
}

function isGameId(value) { return /^[0-9a-f]{64}$/i.test(value ?? ''); }
function bytesToHex(value) { return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
