// Anonymous user feedback delivery.
//
// The browser sends only a message plus non-identifying context (page,
// viewport, user agent). The server validates it, durably writes it to a spill
// queue before anything can fail, forwards it to a private Telegram chat via
// `sendMessage`, and silently retries queued entries until they land. The bot
// token and chat id come from the environment and never reach the browser, and
// the feedback text itself is never logged.
//
// Telegram is deliberately invisible to the user: from their point of view the
// app accepts "a bug, an idea, or something that felt confusing" and thanks
// them. The endpoint stays unavailable (503) when Telegram is not configured
// rather than pretending feedback was collected.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ProtocolError } from './protocol.js';

export const FEEDBACK_MAX_MESSAGE = 1500;
export const FEEDBACK_MAX_PAGE = 128;
export const FEEDBACK_MAX_SCREEN = 32;
export const FEEDBACK_MAX_BROWSER = 200;

export function validateFeedback(input = {}) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new ProtocolError('INVALID_FEEDBACK', 'Feedback message is required');
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    throw new ProtocolError('FEEDBACK_TOO_LONG', `Feedback must be at most ${FEEDBACK_MAX_MESSAGE} characters`);
  }
  return {
    message,
    page: cap(input.page, FEEDBACK_MAX_PAGE),
    screen: cap(input.screen, FEEDBACK_MAX_SCREEN),
    browser: cap(input.browser, FEEDBACK_MAX_BROWSER),
  };
}

function cap(value, max) {
  return typeof value === 'string' ? value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, max) : '';
}

export function formatFeedbackMessage(entry, now = new Date()) {
  const details = [];
  if (entry.page) details.push(`Page: ${entry.page}`);
  if (entry.screen) details.push(`Screen: ${entry.screen}`);
  if (entry.browser) details.push(`Browser: ${entry.browser}`);
  details.push(`Received: ${formatUtc(now)}`);
  return [`New Even/Odd feedback`, '', entry.message, '', details.join('\n')].join('\n');
}

function formatUtc(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export class TelegramFeedback {
  constructor({ botToken, chatId, fetchImpl = fetch, now = () => new Date() } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  get enabled() {
    return Boolean(this.botToken) && Boolean(this.chatId);
  }

  async deliver(entry) {
    if (!this.enabled) throw new Error('Telegram feedback is not configured');
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatFeedbackMessage(entry, this.now()),
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
}

export class FeedbackSpill {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.entries = [];
    this.loaded = false;
  }

  async add(feedback) {
    await this.#load();
    this.entries.push({ id: randomUUID(), receivedAt: this.now().toISOString(), ...feedback });
    await this.#persist();
    return this.entries[this.entries.length - 1];
  }

  async remove(entry) {
    await this.#load();
    const next = this.entries.filter((candidate) => candidate.id !== entry.id);
    if (next.length === this.entries.length) return;
    this.entries = next;
    await this.#persist();
  }

  // Retries every queued entry once. Entries the handler accepts are removed;
  // failures stay queued for the next drain.
  async drain(handler) {
    await this.#load();
    const remaining = [];
    let changed = false;
    for (const entry of this.entries) {
      try {
        await handler(entry);
        changed = true;
      } catch {
        remaining.push(entry);
      }
    }
    if (changed) {
      this.entries = remaining;
      await this.#persist();
    }
  }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      // First run, empty file, or unreadable file: start with an empty queue.
    }
  }

  async #persist() {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.entries), 'utf8');
    await rename(temporary, this.filePath);
  }
}

export class FeedbackService {
  constructor({ deliverer, spill, metrics, now = () => new Date(), logger = console } = {}) {
    this.deliverer = deliverer;
    this.spill = spill;
    this.metrics = metrics;
    this.now = now;
    this.logger = logger;
  }

  // Write-ahead: the feedback is durable before delivery is attempted, so a
  // Telegram outage (or a crash mid-flight) never loses it.
  async submit(input) {
    const feedback = validateFeedback(input);
    if (!this.deliverer.enabled) {
      throw new ProtocolError('FEEDBACK_UNAVAILABLE', 'Feedback is not available right now');
    }
    const entry = await this.spill.add(feedback);
    try {
      await this.deliverer.deliver(entry);
      await this.spill.remove(entry);
      this.metrics?.recordFeedback({ outcome: 'delivered' });
      return { accepted: true };
    } catch (error) {
      this.metrics?.recordFeedback({ outcome: 'queued' });
      this.logger.error?.('feedback_delivery_failed', { message: error?.message });
      return { accepted: true, queued: true };
    }
  }

  async drainPending() {
    let drained = 0;
    await this.spill.drain(async (entry) => {
      await this.deliverer.deliver(entry);
      this.metrics?.recordFeedback({ outcome: 'delivered' });
      drained += 1;
    });
    if (drained > 0) this.logger.info?.('feedback_delivered_from_queue', { count: drained });
  }
}