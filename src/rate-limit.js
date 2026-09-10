// Fixed-window rate limiter with a bounded key space.
//
// Keys are client addresses, so the map is capped and swept to keep a public
// endpoint from retaining unbounded per-client state.
export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 4096, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.windows = new Map();
  }

  check(key) {
    const now = this.now();
    this.#sweep(now);
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.delete(key);
      this.windows.set(key, window);
    }
    window.count += 1;
    const allowed = window.count <= this.limit;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
    return { allowed, retryAfterSeconds };
  }

  #sweep(now) {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      this.windows.delete(oldest);
    }
  }
}
