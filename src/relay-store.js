// Bounded, expiring, in-memory relay for non-secret game discovery payloads.
//
// Clients re-verify every relay payload on-chain, so the relay is untrusted by
// design. Bounding its lifetime and size keeps a public endpoint from growing
// process memory without limit.
import { ProtocolError } from './protocol.js';

export class RelayStore {
  constructor({ maxEntries = 5000, maxPayloadBytes = 262_144, ttlMs = 600_000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxPayloadBytes = maxPayloadBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  set(id, value, serializedLength) {
    this.#sweep();
    const size = serializedLength ?? JSON.stringify(value).length;
    if (size > this.maxPayloadBytes) throw new ProtocolError('RELAY_PAYLOAD_TOO_LARGE', 'Relay payload exceeds the maximum size');
    this.entries.delete(id);
    this.entries.set(id, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  get(id) {
    this.#sweep();
    const entry = this.entries.get(id);
    return entry ? entry.value : null;
  }

  size() {
    this.#sweep();
    return this.entries.size;
  }

  #sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
