import { NETWORK, ProtocolError, validateNetwork } from './protocol.js';

const MINIMUM_VERSION = [2, 59, 8];

export class KastleWalletAdapter {
  constructor(provider, { onChange } = {}) {
    this.provider = provider;
    this.account = null;
    this.network = null;
    this.invalidated = false;
    this.removeListeners = [];
    this.changeListeners = new Set(typeof onChange === 'function' ? [onChange] : []);
  }

  async connect() {
    if (!this.provider || typeof this.provider.connect !== 'function') {
      throw new ProtocolError('WALLET_UNAVAILABLE', 'Kastle wallet extension is not installed');
    }
    if (!(await this.provider.connect())) {
      throw new ProtocolError('WALLET_REJECTED', 'Kastle connection was not approved');
    }
    const [account, network, version] = await Promise.all([
      this.provider.getAccount(),
      this.provider.getNetwork(),
      this.provider.getVersion(),
    ]);
    validateNetwork(network);
    if (!isSupportedVersion(version)) {
      throw new ProtocolError('WALLET_UNSUPPORTED', 'Kastle 2.59.8 or newer is required');
    }
    if (typeof this.provider.signTx !== 'function') {
      throw new ProtocolError('WALLET_UNSUPPORTED', 'Kastle signTx capability is required');
    }
    if (!account?.address || !account?.publicKey) {
      throw new ProtocolError('WALLET_ACCOUNT_MISSING', 'Kastle did not return an active account');
    }
    if (!account.address.startsWith('kaspatest:')) {
      throw new ProtocolError('WALLET_ACCOUNT_MISMATCH', 'Kastle account must use a Kaspa testnet address');
    }
    this.account = account;
    this.network = network;
    this.invalidated = false;
    this.#listen('accountsChanged', (accounts) => {
      if (accounts?.[0] !== this.account?.address) this.#invalidate('account');
    });
    this.#listen('networkChanged', (nextNetwork) => {
      if (nextNetwork !== NETWORK) this.#invalidate('network');
    });
    return Object.freeze({ ...account, network, version });
  }

  async sign(prepared) {
    if (!this.account || this.invalidated) {
      throw new ProtocolError('WALLET_CHANGED', 'Reconnect Kastle after an account or network change');
    }
    validateNetwork(prepared.network);
    if (prepared.creatorAddress !== this.account.address) {
      throw new ProtocolError('WALLET_ACCOUNT_MISMATCH', 'Prepared creator does not match the active Kastle account');
    }
    if (typeof prepared.txJson !== 'string' || !prepared.preparedHash) {
      throw new ProtocolError('INVALID_TRANSACTION', 'Prepared SafeJSON and template hash are required');
    }
    validateNetwork(await this.provider.getNetwork());
    const signedTxJson = await this.provider.signTx(NETWORK, prepared.txJson);
    const [account, network] = await Promise.all([this.provider.getAccount(), this.provider.getNetwork()]);
    if (this.invalidated || account?.address !== this.account.address || network !== NETWORK) {
      this.invalidated = true;
      throw new ProtocolError('WALLET_CHANGED', 'Wallet changed during transaction approval');
    }
    if (typeof signedTxJson !== 'string' || signedTxJson.length === 0) {
      throw new ProtocolError('SIGNING_FAILED', 'Kastle did not return signed SafeJSON');
    }
    return signedTxJson;
  }

  dispose() {
    for (const remove of this.removeListeners) remove();
    this.removeListeners = [];
    this.changeListeners.clear();
  }

  subscribe(onChange) {
    if (typeof onChange !== 'function') throw new ProtocolError('INVALID_CALLBACK', 'Wallet change callback is required');
    this.changeListeners.add(onChange);
    return () => this.changeListeners.delete(onChange);
  }

  #listen(event, handler) {
    if (typeof this.provider.on !== 'function') return;
    this.provider.on(event, handler);
    this.removeListeners.push(() => this.provider.removeListener?.(event, handler));
  }

  #invalidate(reason) {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const listener of this.changeListeners) listener({ reason, account: null, network: null });
  }
}

export async function waitForKastleProvider({ getProvider, attempts = 20, intervalMs = 100, wait = defaultWait }) {
  if (typeof getProvider !== 'function') {
    throw new ProtocolError('WALLET_UNAVAILABLE', 'Kastle provider detector is required');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const provider = getProvider();
    if (provider) return provider;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  throw new ProtocolError('WALLET_UNAVAILABLE', 'Kastle wallet extension is not installed');
}

function isSupportedVersion(version) {
  if (typeof version !== 'string') return false;
  const parts = version.split('.').map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    if (parts[index] > MINIMUM_VERSION[index]) return true;
    if (parts[index] < MINIMUM_VERSION[index]) return false;
  }
  return true;
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
