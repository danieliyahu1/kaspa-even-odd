export const PROTOCOL_VERSION = 'EO/v1';
export const NETWORK = 'testnet-10';
export const MIN_STAKE_KAS = 1;
export const MAX_STAKE_KAS = 100;
export const SOMPI_PER_KAS = 100_000_000n;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function stakeToSompi(stakeKas) {
  if (!Number.isInteger(stakeKas) || stakeKas < MIN_STAKE_KAS || stakeKas > MAX_STAKE_KAS) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be an integer from ${MIN_STAKE_KAS} to ${MAX_STAKE_KAS} KAS`);
  }
  return BigInt(stakeKas) * SOMPI_PER_KAS;
}

export function validateSide(side) {
  if (side !== 'even' && side !== 'odd') {
    throw new ProtocolError('INVALID_SIDE', 'Side must be even or odd');
  }
  return side;
}

export function validateNetwork(network) {
  if (network !== NETWORK) {
    throw new ProtocolError('WRONG_NETWORK', `Expected ${NETWORK}`);
  }
}

export function validateGameId(gameId) {
  if (typeof gameId !== 'string' || !/^[0-9a-f]{64}$/i.test(gameId)) {
    throw new ProtocolError('INVALID_GAME_ID', 'Game identifier must be a 32-byte hexadecimal value');
  }
  return gameId.toLowerCase();
}

export function validateFeeSeparation({ gameValue, feeValue }) {
  if (typeof gameValue !== 'bigint' || gameValue <= 0n) {
    throw new ProtocolError('INVALID_GAME_VALUE', 'Game output value must be positive sompi');
  }
  if (typeof feeValue !== 'bigint' || feeValue < 0n) {
    throw new ProtocolError('INVALID_FEE', 'Fee must be a non-negative sompi amount');
  }
  return { gameValue, feeValue };
}
