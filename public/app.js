import { bindSecretToGame, createRevealSecret, deleteSecretForGame, loadSecretForGame, transientCommitment } from '/secrets.js';
import { verifyCreation } from '/verify.js';
import { createGame, joinGame, reveal as clientReveal, refundOrClaim, loadHydratedGame, readRecoveryReadiness } from '/game-client.js';
import { DEFAULT_WRPC_URL } from '/src/wrpc.mjs';
import { logDebug, logInfo, logWarn, logError } from '/log.js';
import { signWithKasware as kaswareSignPskt } from '/kasware-signing.js';

const NETWORK = 'testnet-10';
const KASWARE_NETWORK = 'kaspa_testnet_10';
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const KASWARE_DOWNLOAD = 'https://chromewebstore.google.com/detail/kasware-wallet/hklhheigdmpoolooomdihmhlpjjdbklf';
let serverWrpcUrl = null;

boot();

async function boot() {
  try {
    // Never block first paint on the coordinating server: content renders
    // immediately and the config only refines the preferred wRPC endpoint.
    void loadServerConfig();
    initWalletButton();
    if (location.pathname === '/join') return renderJoinEntry(params.get('game'));
    if (location.pathname === '/game') return renderGame(params.get('id') ?? params.get('game'));
    if (location.pathname === '/host') return renderCreate();
    if (location.pathname === '/rival') return renderMatchmaking();
    renderHome();
  } catch (error) {
    logError('boot_failed', { code: error.code, message: error.message });
    renderBackendError(error.message);
  }
}

async function loadServerConfig() {
  try {
    const config = await api('/api/config');
    if (config.network !== NETWORK) throw new Error(`Backend must use ${NETWORK}`);
    if (typeof config.wrpcUrl === 'string' && config.wrpcUrl) serverWrpcUrl = config.wrpcUrl;
  } catch (error) {
    // The app must run even if the coordinating server is gone.
    logDebug('config_unavailable', { message: error?.message });
  }
}

function renderHome() {
  app.innerHTML = `
    <section class="panel home-panel" aria-label="Play Even Odd">
      <div class="panel-head">
        <h1>Even / Odd</h1>
        <p class="lead">A quick game of chance on Kaspa.</p>
      </div>
      <div class="home-actions">
        <a class="primary home-button" href="/rival?start=1">Find a rival</a>
        <a class="outline home-button" href="/host">Play with a friend</a>
      </div>
    </section>`;
}

async function renderMatchmaking() {
  app.innerHTML = `
    <a class="back" href="/">Back</a>
    <section class="panel" aria-label="Find a rival">
      <div class="panel-head"><h2>Find a rival</h2><p class="lead">Pick a number. We'll choose your side and match you for 1 KAS.</p></div>
      <div id="matchmaking-content">
        <div class="actions"><button type="button" class="primary" id="match-start">Find a rival</button></div>
      </div>
    </section>`;

  const content = document.querySelector('#matchmaking-content');
  let provider;
  let account;
  let match;
  let pollTimer;
  let vote = null;
  let started = false;

  async function startMatchmaking() {
    const button = document.querySelector('#match-start');
    button.disabled = true;
    try {
      ({ provider, account } = await connectKasware('#matchmaking-content'));
      rememberAddress(account.address);
      match = await api('/api/matchmaking/join', { method: 'POST', body: { address: account.address, publicKey: account.publicKey } });
      renderMatchState();
      pollTimer = setInterval(() => { void refreshMatch(); }, 2500);
      await refreshMatch();
    } catch (error) {
      button.disabled = false;
      logError('matchmaking_failed', { code: error.code, message: error.message });
      showNotice('#matchmaking-content', 'Could not find a rival', error.message, 'error');
    }
  }

  document.querySelector('#match-start').addEventListener('click', startMatchmaking);
  if (params.get('start') === '1') void startMatchmaking();

  function renderMatchState() {
    if (match.status === 'waiting') {
      content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Finding your rival</span></div><button type="button" class="outline" id="match-leave">Cancel</button>`;
      document.querySelector('#match-leave').addEventListener('click', leave);
      return;
    }
    if (match.status === 'cancelled' || !match.opponentConnected) {
      content.innerHTML = '<div class="notice error"><strong>Your rival left.</strong>No KAS was locked.</div><div class="actions"><a class="primary home-button" href="/rival">Find another rival</a></div>';
      return;
    }
    if (!match.voteLocked) {
      content.innerHTML = `
        <div class="notice"><strong>Rival found.</strong>You're ${escapeHtml(capitalize(match.side))}.</div>
        <fieldset class="choice-group">
          <legend>Your number</legend>
          <div class="choice-row">
            <button type="button" class="choice num" data-match-vote="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
            <button type="button" class="choice num" data-match-vote="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
          </div>
        </fieldset>
        <div class="summary">
          <div class="sum-item"><small>Stake</small><strong>${escapeHtml(match.stakeKas)} KAS</strong></div>
          <div class="sum-item"><small>Pot</small><strong>${escapeHtml(match.stakeKas * 2)} KAS</strong></div>
        </div>
        <div id="match-vote-notice"></div>
        <div class="actions"><button type="button" class="primary" id="match-vote" disabled>Play for ${escapeHtml(match.stakeKas)} KAS</button></div>`;
      document.querySelectorAll('[data-match-vote]').forEach((button) => button.addEventListener('click', () => {
        vote = Number(button.dataset.matchVote);
        document.querySelectorAll('[data-match-vote]').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        document.querySelector('#match-vote').disabled = false;
      }));
      document.querySelector('#match-vote').addEventListener('click', commitVote);
      return;
    }
    const message = match.ready ? 'Starting your game' : 'Waiting for your rival to lock in the game';
    content.innerHTML = `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">${message}</span></div>`;
  }

  async function commitVote() {
    if (vote === null) return;
    const button = document.querySelector('#match-vote');
    button.disabled = true;
    try {
      match = await api(`/api/matchmaking/${match.matchId}/commit`, { method: 'POST', body: { address: account.address, commitment: transientCommitment(vote) } });
      renderMatchState();
      await advanceMatch();
    } catch (error) {
      button.disabled = false;
      logError('match_vote_failed', { code: error.code, message: error.message });
      showNotice('#match-vote-notice', 'Game was not started', error.message, 'error');
    }
  }

  async function refreshMatch() {
    if (started) return;
    try {
      const previous = match;
      match = await api(`/api/matchmaking/${match.matchId}?address=${encodeURIComponent(account.address)}`);
      const changed = previous.status !== match.status
        || previous.opponentConnected !== match.opponentConnected
        || previous.voteLocked !== match.voteLocked
        || previous.ready !== match.ready
        || previous.gameId !== match.gameId;
      if (changed) renderMatchState();
      await advanceMatch();
    } catch (error) {
      if (error.code === 'MATCH_NOT_FOUND') clearInterval(pollTimer);
    }
  }

  async function advanceMatch() {
    // The creator funds as soon as they have picked; the joiner waits for that
    // covenant output to exist on-chain, since the join tx must spend it.
    if (started || !match.voteLocked) return;
    if (match.role === 'creator' && !match.gameId) {
      started = true;
      clearInterval(pollTimer);
      await startCreation();
    } else if (match.role === 'joiner' && match.gameId) {
      started = true;
      clearInterval(pollTimer);
      await startJoin();
    }
  }

  async function startCreation() {
    try {
      content.innerHTML = '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Preparing your 1 KAS game</span></div>';
      const secret = await createRevealSecret(vote);
      const prepared = await api('/api/games/prepare', { method: 'POST', body: {
        creatorAddress: account.address,
        creatorPublicKey: account.publicKey,
        creatorCommitment: secret.commitment,
        side: match.side,
        stakeKas: 1,
        matchId: match.matchId,
      } });
      await verifyCreation({ txJson: prepared.txJson, creatorPublicKey: account.publicKey, creatorCommitment: secret.commitment, side: match.side, stakeKas: 1, deadlineDaa: prepared.deadlineDaa });
      showNotice('#matchmaking-content', 'Confirm in KasWare', `Approve the ${match.stakeKas} KAS transaction.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      const game = await api('/api/games/submit', { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson, matchId: match.matchId } });
      await bindSecretToGame(game.gameId, secret.secretId);
      location.href = `/game?id=${game.gameId}`;
    } catch (error) {
      showMatchStartError(error);
    }
  }

  async function startJoin() {
    try {
      content.innerHTML = '<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for the 1 KAS game to be ready</span></div>';
      await waitForJoinableGame(match.gameId);
      const secret = await createRevealSecret(vote);
      await bindSecretToGame(match.gameId, secret.secretId);
      const prepared = await api(`/api/games/${match.gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
        matchId: match.matchId,
      } });
      showNotice('#matchmaking-content', 'Confirm in KasWare', `Approve the ${match.stakeKas} KAS transaction.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${match.gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      location.href = `/game?id=${match.gameId}`;
    } catch (error) {
      showMatchStartError(error);
    }
  }

  async function waitForJoinableGame(gameId) {
    while (true) {
      const game = await api(`/api/games/${gameId}`);
      if (game.canJoin) return;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  function showMatchStartError(error) {
    started = false;
    logError('match_start_failed', { code: error.code, message: error.message });
    content.innerHTML = `<div class="notice error"><strong>Game was not started.</strong>${escapeHtml(error.message)}</div><div class="actions"><button type="button" class="primary" id="match-retry">Try again</button></div>`;
    document.querySelector('#match-retry').addEventListener('click', () => {
      started = true;
      if (match.role === 'creator') void startCreation();
      else void startJoin();
    });
  }

  async function leave() {
    clearInterval(pollTimer);
    await api(`/api/matchmaking/${match.matchId}/leave`, { method: 'POST', body: { address: account.address } }).catch(() => {});
    location.href = '/';
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
        <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
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
      const { provider, account } = await connectKasware('#create-notice');
      rememberAddress(account.address);
      showNotice('#create-notice', 'Locking your stake', 'Confirm the transaction in KasWare.', '');
      const result = await createGame({ wallet: kaswareWallet(provider, account), side, number, stakeKas: stake, rpcUrl: preferredRpcUrl() });
      location.href = `/game?id=${result.gameId}`;
    } catch (error) {
      submit.disabled = false;
      logError('create_game_failed', { code: error.code, message: error.message });
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
   const createSubmit = document.querySelector('#create-submit');
   if (createSubmit) createSubmit.disabled = true;
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
        <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
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
      const { provider, account } = await connectKasware('#join-notice');
      rememberAddress(account.address);
      const secret = await createRevealSecret(number);
      await bindSecretToGame(gameId, secret.secretId);
      const prepared = await api(`/api/games/${gameId}/join/prepare`, { method: 'POST', body: {
        joinerAddress: account.address,
        joinerPublicKey: account.publicKey,
        joinerCommitment: secret.commitment,
      } });
      showNotice('#join-notice', 'Confirm in KasWare', `Match ${theirStake} KAS. Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/join/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      submit.disabled = false;
      logError('join_game_failed', { code: error.code, message: error.message });
      showNotice('#join-notice', error.message, '', 'error');
    }
  });
}

async function renderGame(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  const local = await loadHydratedGame(gameId).catch(() => null);
  if (local) return renderClientGame(gameId, local);
  scheduleGameRefresh(gameId);
  try {
    const game = await api(`/api/games/${gameId}`);
    const recovery = await readRecovery(game.safetyAction
      ? { action: game.safetyAction, deadlineDaa: game.deadlineDaa, output: game.safetyOutput } : null);
    paintGame(gameId, game, recovery);
  } catch (error) {
    renderBackendError(error.message);
  }
}

async function renderJoinEntry(gameId) {
  if (!isGameId(gameId)) return renderBackendError('That game link doesn\u2019t look right.');
  const creation = creationFromParams();
  const local = await loadHydratedGame(gameId).catch(() => null);
  if (local) return renderClientGame(gameId, local);
  if (creation) return renderClientJoin(gameId, creation);
  return renderGame(gameId);
}

function creationFromParams() {
  const pk = params.get('pk');
  const commitment = params.get('c');
  const side = params.get('s');
  const stake = params.get('k');
  const deadline = params.get('d');
  if (!pk || !commitment || !side || !stake || !deadline) return null;
  return {
    creatorPublicKey: pk,
    creatorCommitment: commitment,
    side: side === 'e' ? 'even' : 'odd',
    stakeKas: Number(stake),
    deadlineDaa: BigInt(deadline),
    creatorAddress: params.get('a') || null,
  };
}

function renderClientJoin(gameId, creation) {
  const yourSide = creation.side === 'even' ? 'odd' : 'even';
  app.innerHTML = `
    <a class="back" href="/">Exit</a>
    <section class="panel" aria-label="Join game">
      <div class="panel-head"><h2>You're in.</h2></div>
      <div class="game-body">
        <div class="hero-card" id="join-card">
          <p class="lead">You're <strong class="side-strong">${capitalize(yourSide)}</strong>.</p>
          <form class="form" id="client-join-form">
            <fieldset class="choice-group">
              <legend>Your number</legend>
              <div class="choice-row">
                <button type="button" class="choice num" data-join-number="1" aria-pressed="false"><span class="num-big">1</span><small class="num-tag">Odd</small></button>
                <button type="button" class="choice num" data-join-number="0" aria-pressed="false"><span class="num-big">2</span><small class="num-tag">Even</small></button>
              </div>
            </fieldset>
            <p class="fate">Stake ${escapeHtml(creation.stakeKas)} KAS. Winner takes ${escapeHtml(creation.stakeKas * 2)} KAS.</p>
            <div id="join-notice"></div>
            <p class="muted-note">Your number is saved only in this browser. Clearing site data before you reveal forfeits your stake.</p>
            <div class="actions"><button type="submit" class="primary" id="join-submit" disabled>Join for ${escapeHtml(creation.stakeKas)} KAS</button></div>
          </form>
        </div>
      </div>
    </section>`;
  let number = null;
  const submit = document.querySelector('#join-submit');
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
  document.querySelector('#client-join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (number === null) return showNotice('#join-notice', 'Pick a number', 'Choose 1 or 2 before you join.', 'error');
    submit.disabled = true;
    try {
      const { provider, account } = await connectKasware('#join-notice');
      rememberAddress(account.address);
      showNotice('#join-notice', 'Matching the stake', 'Confirm the transaction in KasWare.', '');
      await joinGame({ wallet: kaswareWallet(provider, account), gameId, creation, number, rpcUrl: preferredRpcUrl() });
      location.href = `/game?id=${gameId}`;
    } catch (error) {
      submit.disabled = false;
      logError('client_join_failed', { code: error.code, message: error.message });
      showNotice('#join-notice', error.message, '', 'error');
    }
  });
}

async function renderClientGame(gameId, record) {
  const role = clientRole(record);
  const revealed = Boolean(record.reveals?.[role]);
  const settled = ['settled', 'fallback_claimed_broadcast', 'refunded', 'creator_refund_broadcast'].includes(record.status);
  void forgetRevealSecret(gameId, settled);
  const yourSide = role === 'joiner' ? (record.creator?.side === 'even' ? 'odd' : 'even') : record.creator?.side;
  const invite = role === 'creator' && !record.joiner ? clientInviteUrl(gameId, record) : null;
  const recovery = await readRecovery(clientRecovery(record, role));
  const recoverControl = (label) => recoveryControlHtml(recovery, label, 'client-recover');
  app.innerHTML = `
    <a class="back" href="/">Exit</a>
    <section class="panel" aria-label="Game">
      <div class="panel-head"><h2>${settled ? 'Game over' : record.joiner ? "It's on." : 'Your game is ready.'}</h2></div>
      <div class="game-body">
        <div class="summary">
          <div class="sum-item"><small>Stake</small><strong>${escapeHtml(record.stakeKas)} KAS</strong></div>
          <div class="sum-item"><small>Pot</small><strong>${escapeHtml(record.stakeKas * 2)} KAS</strong></div>
        </div>
        ${yourSide ? `<p class="muted-note">You're ${escapeHtml(capitalize(yourSide))}.</p>` : ''}
        ${invite ? `<div class="invite-box"><p class="muted-note">Share this link with your friend:</p><button class="share-button" data-action="copy-invite">Copy link</button></div>` : ''}
        ${record.joiner && !settled && !revealed ? '<div class="actions"><button type="button" class="primary" data-action="client-reveal">Reveal number</button></div>' : ''}
        ${record.joiner && !settled ? recoverControl('Claim or refund') : ''}
        ${!record.joiner ? recoverControl('Cancel and refund') : ''}
        <div id="client-notice"></div>
        <p class="muted-note">This game is enforced by the Kaspa covenant. The site cannot move your funds or change the result.</p>
      </div>
    </section>`;
  document.querySelector('[data-action="copy-invite"]')?.addEventListener('click', async (event) => {
    try { await navigator.clipboard.writeText(invite); flashCopy(event.target); } catch { /* ignore */ }
  });
  document.querySelector('[data-action="client-reveal"]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const { provider, account } = await connectKasware('#client-notice');
      rememberAddress(account.address);
      showNotice('#client-notice', 'Revealing', 'Confirm the transaction in KasWare.', '');
      await clientReveal({ wallet: kaswareWallet(provider, account), gameId, rpcUrl: preferredRpcUrl() });
      location.reload();
    } catch (error) {
      event.target.disabled = false;
      logError('client_reveal_failed', { code: error.code, message: error.message });
      showNotice('#client-notice', error.message, '', 'error');
    }
  });
  document.querySelector('[data-action="client-recover"]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const { provider, account } = await connectKasware('#client-notice');
      rememberAddress(account.address);
      showNotice('#client-notice', 'Recovering', 'Confirm the transaction in KasWare.', '');
      const result = await refundOrClaim({ wallet: kaswareWallet(provider, account), gameId, rpcUrl: preferredRpcUrl() });
      showNotice('#client-notice', 'Submitted', `${result.action} broadcast.`, '');
      location.reload();
    } catch (error) {
      event.target.disabled = false;
      logError('client_recover_failed', { code: error.code, message: error.message });
      showNotice('#client-notice', error.message, '', 'error');
    }
  });
  window.__clientSignature = `${clientSignature(record)}|${recovery ? recovery.ready : ''}`;
  bindRecoveryCountdown(recovery, async () => {
    const fresh = await loadHydratedGame(gameId).catch(() => null);
    if (fresh) renderClientGame(gameId, fresh);
  });
  scheduleClientRefresh(gameId, record);
}

function scheduleClientRefresh(gameId, record) {
  clearInterval(window.__clientRefresh);
  window.__clientRefresh = setInterval(async () => {
    if (!(location.pathname === '/game' || location.pathname === '/join') || (params.get('id') ?? params.get('game')) !== gameId) {
      clearInterval(window.__clientRefresh);
      return;
    }
    const fresh = await loadHydratedGame(gameId).catch(() => null);
    if (!fresh) return;
    const recovery = await readRecovery(clientRecovery(fresh, clientRole(fresh)));
    const signature = `${clientSignature(fresh)}|${recovery ? recovery.ready : ''}`;
    if (signature !== window.__clientSignature) renderClientGame(gameId, fresh);
  }, 4_000);
}

function clientSignature(record) {
  return [record.joiner?.address ?? '', record.status ?? '', record.firstRevealer ?? '', Object.keys(record.reveals ?? {}).join(',')].join('|');
}

function formatWait(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The refund/claim button state comes from the chain, not the server: the
// server only points at the public covenant output to read. If the chain can't
// be reached we fail open (`ready: null`) and let the covenant enforce the wait
// on-chain, instead of wedging the button disabled forever.
async function readRecovery(request) {
  if (!request) return null;
  try {
    return await readRecoveryReadiness({ rpcUrl: preferredRpcUrl(), ...request });
  } catch (error) {
    logWarn('recovery_readiness_failed', { message: error?.message });
    return { ready: null, remainingSeconds: null };
  }
}

// Tri-state readiness: `true` = available, `false` + countdown = wait, `null` =
// unknown (fail open; the covenant still rejects a premature claim on-chain).
function recoveryControlState(recovery) {
  if (!recovery || recovery.ready === true) return { disabled: false, wait: null, unknown: false };
  if (recovery.ready === false && recovery.remainingSeconds != null) {
    return { disabled: true, wait: Number(recovery.remainingSeconds), unknown: false };
  }
  return { disabled: false, wait: null, unknown: true };
}

function recoveryControlHtml(recovery, label, action) {
  const state = recoveryControlState(recovery);
  const note = state.wait != null
    ? `<p class="muted-note" data-recovery-wait data-remaining="${state.wait}">Available in ${formatWait(state.wait)}</p>`
    : state.unknown
      ? '<p class="muted-note">Can\'t reach the chain right now; the covenant still enforces the wait.</p>'
      : '';
  return `<div class="actions"><button type="button" class="outline" data-action="${action}" data-recovery-button ${state.disabled ? 'disabled' : ''}>${label}</button></div>${note}`;
}

function clientRole(record) {
  return record.creator?.address === window.__connectedAddress ? 'creator'
    : record.joiner?.address === window.__connectedAddress ? 'joiner' : 'viewer';
}

function clientRecovery(record, role) {
  if (!record.joiner) return { action: 'creator_refund', deadlineDaa: record.deadlineDaa };
  const revealedCount = Object.keys(record.reveals ?? {}).length;
  if (revealedCount === 1 && record.reveals?.[role]) {
    return { action: 'fallback_claim', output: { address: record.continuationAddress, outputIndex: 0, scriptPublicKey: record.continuationScriptPublicKey } };
  }
  if (revealedCount === 0) {
    return { action: 'refund_player', output: { address: record.joinedAddress, outputIndex: 0, scriptPublicKey: record.joinedScriptPublicKey } };
  }
  return null;
}

function bindRecoveryCountdown(recovery, refresh) {
  clearInterval(window.__recoveryTicker);
  const element = document.querySelector('[data-recovery-wait]');
  const button = document.querySelector('[data-recovery-button]');
  if (!element || !button || !recovery || recovery.ready) return;
  let remaining = Number(element.dataset.remaining ?? '0');
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  window.__recoveryTicker = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(window.__recoveryTicker);
      element.textContent = 'Available now';
      void refresh();
      return;
    }
    element.textContent = `Available in ${formatWait(remaining)}`;
  }, 1000);
}

function clientInviteUrl(gameId, record) {
  const url = new URL('/join', location.origin);
  url.searchParams.set('v', 'EO/v2');
  url.searchParams.set('game', gameId);
  url.searchParams.set('pk', record.creator.publicKey);
  url.searchParams.set('c', record.creator.commitment);
  url.searchParams.set('s', record.creator.side === 'even' ? 'e' : 'o');
  url.searchParams.set('k', String(record.stakeKas));
  url.searchParams.set('d', String(record.deadlineDaa));
  if (record.creator.address) url.searchParams.set('a', record.creator.address);
  return url.toString();
}

function signWithKasware(provider, txJson) {
  logInfo('kasware_sign_request');
  return Promise.resolve(kaswareSignPskt(provider, txJson))
    .then((signed) => {
      logInfo('kasware_sign_result', { returned: typeof signed === 'string' && signed.length > 0 });
      return signed;
    })
    .catch((error) => {
      logError('kasware_sign_failed', { code: error?.code, message: error?.message });
      throw error;
    });
}

function kaswareWallet(provider, account) {
  return {
    address: account.address,
    publicKey: account.publicKey,
    signTx: (txJson) => signWithKasware(provider, txJson),
  };
}

function preferredRpcUrl() {
  const fromParam = params.get('node');
  if (fromParam) {
    try { localStorage.setItem('kaspa-rpc-url', fromParam); } catch { /* ignore */ }
    return fromParam;
  }
  try { return localStorage.getItem('kaspa-rpc-url') || serverWrpcUrl || DEFAULT_WRPC_URL; }
  catch { return serverWrpcUrl || DEFAULT_WRPC_URL; }
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

async function paintGame(gameId, game, recovery) {
  const role = detectRole(game);
  const yourSide = role === 'creator' ? game.creator?.side : role === 'joiner' ? (game.creator?.side === 'even' ? 'odd' : 'even') : null;
  const header = paintGameHeader(game.status, role, game);
  const joinerView = role === 'joiner' || (role === 'viewer' && game.canJoin);
  const active = !['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status);
  void forgetRevealSecret(gameId, !active);
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
        ${safetySection(game, recovery)}
        ${terminalSection(game)}
      </div>
    </section>`;

  await bindJoin(gameId, game);
  bindReveal(gameId);
  bindShare();
  bindSafety(gameId, game);
  bindRecoveryCountdown(recovery, () => refreshGame(gameId));
  bindPlayAgain();
}

function inviteBox(game, waiting) {
  if (['settled', 'fallback_claimed', 'refunded', 'creator_refunded'].includes(game.status)) return '';
  const waitingRow = waiting
    ? `<div class="waiting-row"><span class="spinner friend" aria-hidden="true"></span><span class="waiting-text">Waiting for your ${game.matchmaking ? 'rival' : 'friend'}</span></div>`
    : '';
  if (game.matchmaking) return `<div class="invite-box" id="invite-box">${waitingRow}</div>`;
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
      <div class="actions"><button type="button" class="primary" data-action="reveal">Reveal number</button></div>
    </div>`;
}

function isMyReveal(game, role) {
  if (role !== 'creator' && role !== 'joiner') return false;
  return game.revealedPicks?.[role] !== undefined;
}

// Once the game is over the reveal nonce is public on-chain, so drop the local
// copy rather than keep a stale secret in IndexedDB indefinitely.
async function forgetRevealSecret(gameId, terminal) {
  if (!terminal) return;
  try {
    await deleteSecretForGame(gameId);
    logInfo('reveal_secret_forgotten', { gameId });
  } catch (error) {
    logWarn('reveal_secret_forget_failed', { gameId, message: error?.message });
  }
}

function bindReveal(gameId) {
  const reveal = document.querySelector('[data-action="reveal"]');
  if (!reveal) return;
  reveal.addEventListener('click', async () => {
    reveal.disabled = true;
    try {
      const { provider, account } = await connectKasware('#reveal-notice');
      rememberAddress(account.address);
      const secret = await loadSecretForGame(gameId);
      if (!secret) {
        showNotice('#reveal-notice', 'Reveal unavailable', 'This browser does not have your unrevealed number for this game. Play the game in the browser you used to start it, and keep this site\'s data.', 'error');
        reveal.disabled = false;
        return;
      }
      const prepared = await api(`/api/games/${gameId}/reveal/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
        choice: secret.choice,
        nonceHex: secret.nonceHex,
      } });
      showNotice('#reveal-notice', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/reveal/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      reveal.disabled = false;
      logError('reveal_failed', { code: error.code, message: error.message });
      if (error.code === 'INVALID_REVEAL') {
        showNotice('#reveal-notice', 'Reveal did not match', 'The saved number no longer matches the locked commitment. You may have started this game in another browser.', 'error');
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

function safetySection(game, recovery) {
  const control = (label) => recoveryControlHtml(recovery, label, 'safety');
  if (game.safetyAction === 'fallback_claim' && game.status === 'first_revealed') {
    return `
      <div id="game-safety" class="safety">
        <p class="lead">If your ${game.matchmaking ? 'rival' : 'friend'} never reveals</p>
        <p class="muted-note">You can claim the whole pot after the wait.</p>
        ${control('Claim pot')}
      </div>`;
  }
  if (game.safetyAction === 'creator_refund' && game.status === 'waiting_for_player_b') {
    return `
      <div id="game-safety" class="safety">
        ${control('Cancel game')}
      </div>`;
  }
  if (game.safetyAction === 'refund_player' && (game.status === 'joined' || game.status === 'refund_partial')) {
    return `
      <div id="game-safety" class="safety">
        <p class="lead">No one revealed</p>
        <p class="muted-note">You can take back your stake after the wait.</p>
        ${control('Refund my stake')}
      </div>`;
  }
  return '';
}

function terminalSection(game) {
  if (game.status === 'fallback_claimed') return `<div class="notice"><strong>Pot claimed.</strong>Your ${game.matchmaking ? 'rival' : 'friend'} never revealed, so you took the pot.</div>`;
  if (game.status === 'refunded' || game.status === 'creator_refunded') return '<div class="notice"><strong>Canceled.</strong>Your stake was returned.</div>';
  if (game.status === 'refund_partial') return '<div class="notice"><strong>Partial refund.</strong>One stake was returned. The other player can still refund theirs.</div>';
  return '';
}

function bindSafety(gameId, game) {
  const safetyButton = document.querySelector('[data-action="safety"]');
  if (!safetyButton || safetyButton.disabled) return;
  safetyButton.addEventListener('click', async () => {
    safetyButton.disabled = true;
    try {
      const { provider, account } = await connectKasware('#game-safety');
      const prepared = await api(`/api/games/${gameId}/${game.safetyAction}/prepare`, { method: 'POST', body: {
        playerAddress: account.address,
        playerPublicKey: account.publicKey,
      } });
      showNotice('#game-safety', 'Confirm in KasWare', `Network fee: ${formatKas(prepared.feeSompi)} KAS.`, '');
      const signedTxJson = await signWithKasware(provider, prepared.txJson);
      if (!signedTxJson) throw new Error('KasWare did not return a signed transaction');
      await api(`/api/games/${gameId}/${game.safetyAction}/submit`, { method: 'POST', body: { preparedHash: prepared.preparedHash, signedTxJson } });
      await refreshGame(gameId);
    } catch (error) {
      safetyButton.disabled = false;
      logError('safety_action_failed', { code: error.code, message: error.message });
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
  const creatorPick = displayPick(game.revealedPicks?.creator);
  const joinerPick = displayPick(game.revealedPicks?.joiner);
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

function displayPick(choice) {
  if (choice === undefined) return '\u00b7';
  return choice === 1 ? 1 : 2;
}

function winnerSideName(game) {
  return game.winner === 'creator' ? (game.creator?.side === 'even' ? 'Even' : 'Odd') : (game.creator?.side === 'even' ? 'Odd' : 'Even');
}

function bindPlayAgain() {
  const again = document.querySelector('[data-action="play-again"]');
  if (again) again.addEventListener('click', () => { location.href = '/'; });
}

function detectRole(game) {
  const address = connectedAddress();
  if (address && game.creator?.address === address) return 'creator';
  if (address && game.joiner?.address === address) return 'joiner';
  return 'viewer';
}

function rememberAddress(address) {
  if (!address) return;
  window.__connectedAddress = address;
  try { localStorage.setItem('kaspa-connected-address', address); } catch { /* ignore */ }
}

function connectedAddress() {
  if (window.__connectedAddress) return window.__connectedAddress;
  try { return localStorage.getItem('kaspa-connected-address'); } catch { return null; }
}

function initWalletButton() {
  const button = document.querySelector('#wallet-button');
  if (!button) return;
  button.addEventListener('click', onWalletClick);
  renderWalletButton();
}

function renderWalletButton() {
  const button = document.querySelector('#wallet-button');
  if (!button) return;
  const address = connectedAddress();
  if (address) {
    button.classList.add('connected');
    button.setAttribute('aria-label', `Connected ${address}. Click to disconnect.`);
    button.innerHTML = `<span class="wallet-dot" aria-hidden="true"></span>${escapeHtml(shortAddress(address))}`;
  } else {
    button.classList.remove('connected');
    button.removeAttribute('aria-label');
    button.textContent = 'Connect Wallet';
  }
}

async function onWalletClick() {
  if (connectedAddress()) {
    window.__connectedAddress = undefined;
    try { localStorage.removeItem('kaspa-connected-address'); } catch { /* ignore */ }
    clearWalletNotice();
    renderWalletButton();
    return;
  }
  try {
    const { account } = await connectKasware('#wallet-notice');
    rememberAddress(account.address);
    clearWalletNotice();
    renderWalletButton();
  } catch {
    renderWalletButton();
  }
}

function clearWalletNotice() {
  const notice = document.querySelector('#wallet-notice');
  if (notice) notice.innerHTML = '';
}

function shortAddress(address) {
  const body = address.startsWith('kaspatest:') ? address.slice('kaspatest:'.length) : address;
  return `${body.slice(0, 6)}\u2026${body.slice(-4)}`;
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
    const recovery = await readRecovery(game.safetyAction
      ? { action: game.safetyAction, deadlineDaa: game.deadlineDaa, output: game.safetyOutput } : null);
    const signature = `${game.status}|${recovery ? recovery.ready : ''}`;
    if (window.__gameStatus === signature) return;
    window.__gameStatus = signature;
    await paintGame(gameId, game, recovery);
  } catch {
    // A transient refresh may race a broadcast; the next tick retries.
  }
}

async function connectKasware(selector) {
  const provider = globalThis.kasware;
  if (!provider) {
    logError('kasware_missing', { download: KASWARE_DOWNLOAD });
    showNotice(selector, 'Install KasWare to play', 'Even/Odd uses the KasWare wallet.', 'error');
    throw new Error(`KasWare wallet extension is required. Get it at ${KASWARE_DOWNLOAD}`);
  }
  logInfo('kasware_connect_start', { selector });
  showNotice(selector, 'Connecting to KasWare', 'Confirm the connection in your wallet.', '');
  const accounts = await provider.requestAccounts().catch((error) => {
    logError('kasware_request_accounts_failed', { message: error?.message });
    return null;
  });
  const address = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!address) {
    logWarn('kasware_connection_rejected');
    throw new Error('KasWare connection was not approved');
  }
  let publicKey = await provider.getPublicKey();
  let network = await provider.getNetwork();
  logDebug('kasware_session', { network, hasPublicKey: Boolean(publicKey) });
  if (network !== KASWARE_NETWORK) {
    if (typeof provider.switchNetwork !== 'function') {
      logError('kasware_network_unsupported', { network, expected: KASWARE_NETWORK });
      throw new Error(`Switch KasWare to ${NETWORK}`);
    }
    logInfo('kasware_switch_network', { from: network, to: KASWARE_NETWORK });
    await provider.switchNetwork(KASWARE_NETWORK);
    network = await provider.getNetwork();
    if (network !== KASWARE_NETWORK) {
      logError('kasware_network_switch_failed', { network, expected: KASWARE_NETWORK });
      throw new Error(`Switch KasWare to ${NETWORK}`);
    }
  }
  if (!address.startsWith('kaspatest:') || !/^[0-9a-f]{64}$|^(02|03)[0-9a-f]{64}$/i.test(publicKey ?? '')) {
    logError('kasware_invalid_account', { testnet: address.startsWith('kaspatest:'), publicKeyLength: publicKey?.length });
    throw new Error('KasWare did not return a valid testnet account');
  }
  if (publicKey.length === 66) publicKey = publicKey.slice(2);
  if (typeof provider.signPskt !== 'function') {
    logError('kasware_signing_unavailable');
    throw new Error('KasWare transaction signing is unavailable');
  }
  logInfo('kasware_connected', { network: KASWARE_NETWORK });
  watchKasware(provider);
  return { provider, account: { address, publicKey } };
}

function watchKasware(provider) {
  if (window.__kaswareWatched || typeof provider.on !== 'function') return;
  window.__kaswareWatched = true;
  const forget = (reason) => () => {
    logWarn('kasware_session_changed', { reason });
    window.__connectedAddress = undefined;
    try { localStorage.removeItem('kaspa-connected-address'); } catch { /* ignore */ }
    clearWalletNotice();
    renderWalletButton();
  };
  provider.on('accountsChanged', forget('accountsChanged'));
  provider.on('networkChanged', forget('networkChanged'));
}

function renderBackendError(message) {
  app.innerHTML = `<a class="back" href="/">Exit</a><section class="panel"><p class="lead">Something went wrong.</p><div class="notice error"><strong>${escapeHtml(message)}</strong></div></section>`;
}

async function api(url, options = {}) {
  const method = options.method ?? 'GET';
  const path = new URL(url, location.origin).pathname;
  let response;
  try {
    response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch (error) {
    logError('api_unreachable', { method, path, message: error.message });
    throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? 'Backend request failed');
    error.code = body.error;
    logWarn('api_error', { method, path, status: response.status, code: error.code, message: error.message });
    throw error;
  }
  logDebug('api_ok', { method, path, status: response.status });
  return body;
}

function showNotice(selector, title, message, kind) {
  const node = document.querySelector(selector);
  if (!node) return;
  const body = message ? escapeHtml(message) : '';
  node.innerHTML = `<div class="notice ${kind}"><strong>${escapeHtml(title)}</strong>${body}</div>`;
}

function isGameId(value) { return /^[0-9a-f]{64}$/i.test(value ?? ''); }
function formatKas(sompi) { return (Number(sompi) / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
