// Node entry point for Even/Odd covenant derivation.
//
// Loads the pinned template artifact from disk and re-exports the pure core
// (even-odd-core.mjs) with a `Buffer`-backed `deriveGameInstance` so existing
// Node callers and tests keep their `.toString('hex')` behavior unchanged.
// The browser imports even-odd-core.mjs directly and supplies the artifact
// fetched over HTTP.
import {
  deriveGameInstance as deriveCore,
  verifyTemplateHash as verifyCore,
  parseCovenantAddress as parseAddressCore,
} from './even-odd-core.mjs';
import { getCovenantTemplate } from './template.mjs';

export const EVEN_ODD_TEMPLATE = getCovenantTemplate();

export function verifyTemplateHash(template = EVEN_ODD_TEMPLATE) {
  return verifyCore(template);
}

export function deriveGameInstance(game, opts = {}) {
  const template = opts.template || EVEN_ODD_TEMPLATE;
  const result = deriveCore(game, { ...opts, template });
  return Object.freeze({
    ...result,
    redeemScript: Buffer.from(result.redeemScript),
    p2shScript: Buffer.from(result.p2shScript),
  });
}

export function parseCovenantAddress(address) {
  return parseAddressCore(address);
}
