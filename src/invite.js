import { NETWORK, PROTOCOL_VERSION, ProtocolError, validateGameId, validateNetwork } from './protocol.js';

const PATH = '/join';

export function serializeInvite({ gameId, origin }) {
  const normalizedGameId = validateGameId(gameId);
  const base = new URL(origin);
  validateNetwork(base.searchParams.get('network') ?? NETWORK);
  base.pathname = PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('v', PROTOCOL_VERSION);
  base.searchParams.set('game', normalizedGameId);
  return base.toString();
}

export function parseInvite(rawUrl, expectedOrigin) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProtocolError('INVALID_INVITE', 'Invite is not a valid URL');
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new ProtocolError('INVALID_INVITE_ORIGIN', 'Invite origin is not trusted');
  }
  if (url.pathname !== PATH) {
    throw new ProtocolError('INVALID_INVITE_PATH', 'Invite path is invalid');
  }
  if (url.searchParams.get('v') !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_PROTOCOL', 'Invite protocol version is unsupported');
  }
  if ([...url.searchParams.keys()].some((key) => !['v', 'game'].includes(key))) {
    throw new ProtocolError('INVALID_INVITE', 'Invite contains unsupported data');
  }
  return { protocolVersion: PROTOCOL_VERSION, network: NETWORK, gameId: validateGameId(url.searchParams.get('game')) };
}
