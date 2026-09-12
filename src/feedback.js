// Anonymous user feedback delivery.
//
// The browser sends only a message. The server validates it, durably writes it
// to a spill queue before anything can fail, forwards it to a private Telegram
// chat via `sendMessage`, and silently retries queued entries until they land.
// A Telegram outage therefore never loses feedback: the entry is stored first
// and sent when the bot is reachable again. The bot token and chat id come from
// the environment and never reach the browser, and the feedback text itself is
// never logged.
//
// Telegram is deliberately invisible to the user: from their point of view the
// app accepts "a bug, an idea, or something that felt confusing" and thanks
// them. If Telegram is not configured the feedback is still stored in the spill
// queue and delivered once the bot is configured, and a `feedback_delivery_disabled`
// warning is logged so the missing bot is noticed without breaking the app.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ProtocolError } from './protocol.js';

export const FEEDBACK_MAX_MESSAGE = 1500;

export function validateFeedback(input = {}) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new ProtocolError('INVALID_FEEDBACK', 'Feedback message is required');
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    throw new ProtocolError('FEEDBACK_TOO_LONG', `Feedback must be at most ${FEEDBACK_MAX_MESSAGE} characters`);
  }
  return { message };
}

export function formatFeedbackMessage(entry) {
  return [`New Even/Odd feedback`, '', entry.message].join('\n');
}

export class TelegramFeedback {
  constructor({ botToken, chatId, fetchImpl = fetch, endpoint } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint ?? `https://api.telegram.org/bot${botToken}/sendMessage`;
  }

  get enabled() {
    return Boolean(this.botToken) && Boolean(this.chatId);
  }

  async deliver(entry) {
    if (!this.enabled) throw new Error('Telegram feedback is not configured');
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatFeedbackMessage(entry),
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

  // Write-ahead: the feedback is durable before anything can fail, so a
  // Telegram outage, a missing bot, or a crash mid-flight never loses it. An
  // entry accepted while the bot is not configured stays queued and is
  // delivered by the next drain once the bot is configured.
  async submit(input) {
    const feedback = validateFeedback(input);
    const entry = await this.spill.add(feedback);
    if (!this.deliverer.enabled) {
      const reason = 'TELEGRAM_FEEDBACK_BOT_TOKEN or TELEGRAM_FEEDBACK_CHAT_ID is not set';
      this.metrics?.recordFeedback({ outcome: 'disabled' });
      this.logger.warn?.('feedback_delivery_disabled', { reason });
      return { accepted: true, queued: true };
    }
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