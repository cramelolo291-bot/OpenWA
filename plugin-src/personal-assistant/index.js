'use strict';

/**
 * Personal AI Assistant — answers only the owner's numbers, never other contacts.
 *
 * The shipped `ai-responder` plugin replies to every inbound chat, which is wrong for a personal
 * assistant: on an account that also serves customers it would answer them too. This plugin keeps
 * the same OpenAI-compatible call, adds an owner allowlist and a short per-chat memory.
 *
 * The owner is decided from ONE identity — the sender's JID (`author` in a group, `from`/`chatId` in
 * a DM) — in two steps:
 *   1. a phone-dialect JID (`@c.us`, `@s.whatsapp.net`) is compared against `ownerNumbers`;
 *   2. anything else, which in practice is a WhatsApp privacy id (`@lid`), is looked up once in the
 *      gateway's lid<->phone table through `ctx.engine.canonicalChatId` and compared as a phone.
 * `ownerLids` is the offline escape hatch for a lid the table has not learned yet.
 *
 * Deliberately NOT trusted: a lid's digits (a different id space — a coincidental match would hand
 * the assistant to a stranger), `contact.number` and `senderPhone` (cache/best-effort values that
 * are not the sender's authenticated identity), and a bare digit string (only a real phone JID names
 * a phone). Any lookup failure is a NO, never a maybe.
 */

const PLUGIN_VERSION = '1.2.0';
const HOOK_PRIORITY = 97;
const HOUR_MS = 60 * 60 * 1000;
const MAX_IN_FLIGHT = 4;
const MAX_HISTORY_MESSAGES = 12;
const MAX_TRACKED_CHATS = 200;
const ERROR_BODY_MAX = 200;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BROADCAST_JID_DOMAINS = new Set(['newsletter', 'broadcast']);
const PHONE_JID_DOMAINS = new Set(['c.us', 's.whatsapp.net']);

function digits(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

/** `@lid` | `group` | `phone` | `unknown`, from the JID's domain. A bare number is not a phone. */
function jidKind(value) {
  const text = String(value ?? '').trim();
  const at = text.lastIndexOf('@');
  if (at === -1) return 'unknown';
  const domain = text.slice(at + 1).toLowerCase();
  if (domain === 'lid') return 'lid';
  if (domain === 'g.us') return 'group';
  return PHONE_JID_DOMAINS.has(domain) ? 'phone' : 'unknown';
}

/** The MSISDN digits of a phone-dialect JID, or null for any other id. */
function phoneOfJid(jid) {
  return jidKind(jid) === 'phone' ? digits(jid) : null;
}

/** The one identity a message is judged by: the participant in a group, the chat itself in a DM. */
function senderJid(message) {
  if (message?.isGroup) return message.author;
  return message?.from ?? message?.chatId;
}

/** True when two MSISDN digit strings are the same number, tolerating the local `0…` spelling. */
function samePhone(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith('62') && `0${a.slice(2)}` === b) return true;
  if (b.startsWith('62') && `0${a.slice(2)}` === a) return true;
  return false;
}

function isOwnerPhone(phone, cfg) {
  return Boolean(phone) && cfg.owners.some(owner => samePhone(owner, phone));
}

function atLeastOne(raw, fallback) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function truncate(text, max) {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function isBroadcastJid(chatId) {
  const at = chatId.lastIndexOf('@');
  return at !== -1 && BROADCAST_JID_DOMAINS.has(chatId.slice(at + 1).toLowerCase());
}

function listOf(raw) {
  return String(raw ?? '')
    .split(/[\s,;]+/)
    .map(digits)
    .filter(Boolean);
}

function parseConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const apiBaseUrl = String(source.apiBaseUrl ?? '').trim();
  if (!apiBaseUrl) throw new Error('personal-assistant: apiBaseUrl is required');

  let url;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new Error('personal-assistant: apiBaseUrl must be a valid URL');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'personal-assistant: apiBaseUrl must be an https URL without credentials, query or fragment (http only for localhost)',
    );
  }

  const apiKey = String(source.apiKey ?? '').trim();
  if (!apiKey) throw new Error('personal-assistant: apiKey is required');

  const model = String(source.model ?? '').trim();
  if (!model) throw new Error('personal-assistant: model is required');

  const owners = listOf(source.ownerNumbers);
  const ownerLids = listOf(source.ownerLids);
  if (owners.length === 0 && ownerLids.length === 0) {
    throw new Error(
      'personal-assistant: ownerNumbers is required (comma separated phone numbers in international format)',
    );
  }

  return {
    apiBaseUrl,
    apiKey,
    model,
    owners,
    ownerLids,
    systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : undefined,
    respondInGroups: source.respondInGroups === true,
    maxOutputTokens: atLeastOne(source.maxOutputTokens, 700),
    maxInputChars: atLeastOne(source.maxInputChars, 4000),
    maxRepliesPerChatPerHour: atLeastOne(source.maxRepliesPerChatPerHour, 30),
    timeoutMs: Math.min(25000, Math.max(1000, atLeastOne(source.timeoutMs, 20000))),
  };
}

/** Owner match without any lookup: the sender's own JID, or an explicitly allowlisted lid. */
function matchesOwnerLocally(message, cfg) {
  const jid = senderJid(message);
  if (isOwnerPhone(phoneOfJid(jid), cfg)) return true;
  return jidKind(jid) === 'lid' && cfg.ownerLids.includes(digits(jid));
}

/**
 * Mapping lookup for an `@lid` sender: one call on the gateway's lid<->phone table. Best effort —
 * an unmapped lid, a stopped engine, a missing `engine:read` grant or a failing lookup all mean
 * "not the owner", never "maybe".
 */
async function matchesOwnerThroughMapping(ctx, cfg, sessionId, message) {
  if (cfg.owners.length === 0) return false;
  const jid = senderJid(message);
  if (jidKind(jid) !== 'lid') return false;
  if (typeof ctx?.engine?.canonicalChatId !== 'function') return false;

  let canonical;
  try {
    canonical = await ctx.engine.canonicalChatId(sessionId, jid);
  } catch (error) {
    ctx.logger?.debug?.(
      `personal-assistant: could not canonicalise ${jid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  return isOwnerPhone(phoneOfJid(canonical), cfg);
}

/** Renders the small markdown subset models emit into WhatsApp's own formatting. */
function mdToWhatsApp(markdown) {
  let text = markdown;
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ');
  text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '_$1_');
  text = text.replace(/\*\*([^*]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_]+?)__/g, '*$1*');
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  return text;
}

class PersonalAssistant {
  ctx = null;
  hour = -1;
  perChat = new Map();
  inFlight = 0;
  seen = new Map();
  /** `${sessionId}:${chatId}` -> alternating user/assistant messages, oldest first. */
  history = new Map();

  async onEnable(ctx) {
    this.ctx = ctx;
    const cfg = parseConfig(ctx.config);
    ctx.registerHook('message:received', hook => this.onMessage(ctx, hook), HOOK_PRIORITY);
    ctx.logger.log(
      `personal-assistant v${PLUGIN_VERSION} enabled: model ${cfg.model}, ${cfg.owners.length} owner number(s), ` +
        `${cfg.ownerLids.length} owner lid(s)`,
    );
  }

  async onConfigChange(ctx) {
    parseConfig(ctx.config);
    ctx.logger.log('personal-assistant: configuration changed');
  }

  async healthCheck() {
    if (!this.ctx) return { healthy: false, message: 'personal-assistant: not enabled' };
    try {
      const cfg = parseConfig(this.ctx.config);
      return { healthy: true, message: `personal-assistant v${PLUGIN_VERSION}: ${cfg.model}` };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async onMessage(ctx, hook) {
    const pass = { continue: true };
    if (hook.source !== 'Engine' || !hook.sessionId) return pass;

    const message = hook.data ?? {};
    if (message.fromMe) return pass;
    if (typeof message.body !== 'string' || !message.body.trim()) return pass;
    if (!message.chatId || !message.id) return pass;
    if (['contact', 'poll', 'order', 'product', 'location'].includes(message.type)) return pass;
    if (isBroadcastJid(message.chatId)) return pass;
    if (message.isGroup && !message.author) return pass;

    let cfg;
    try {
      cfg = parseConfig(ctx.config);
    } catch (error) {
      ctx.logger.warn(
        `personal-assistant: skipping message, config invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      return pass;
    }

    if (message.isGroup && !cfg.respondInGroups) return pass;

    const sessionId = hook.sessionId;
    const owner =
      matchesOwnerLocally(message, cfg) || (await matchesOwnerThroughMapping(ctx, cfg, sessionId, message));
    if (!owner) return pass;

    let seen = this.seen.get(sessionId);
    if (!seen) this.seen.set(sessionId, (seen = new Set()));
    if (seen.has(message.id)) return { continue: false };

    if (!this.withinLimits(ctx, cfg, sessionId, message.chatId)) return pass;

    seen.add(message.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    const { chatId, id, body } = message;
    this.inFlight += 1;
    void this.answer(ctx, cfg, sessionId, chatId, id, body)
      .catch(error => ctx.logger.error(`personal-assistant: reply to ${id} failed`, error))
      .finally(() => {
        this.inFlight -= 1;
      });

    return { continue: false };
  }

  withinLimits(ctx, cfg, sessionId, chatId) {
    const hour = Math.floor(Date.now() / HOUR_MS);
    if (hour !== this.hour) {
      this.hour = hour;
      this.perChat.clear();
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      ctx.logger.warn('personal-assistant: provider calls already open, leaving new messages unanswered');
      return false;
    }
    const key = `${sessionId}:${chatId}`;
    const used = this.perChat.get(key) ?? 0;
    if (used >= cfg.maxRepliesPerChatPerHour) {
      ctx.logger.warn(`personal-assistant: hourly limit reached for ${chatId}`);
      return false;
    }
    this.perChat.set(key, used + 1);
    return true;
  }

  async answer(ctx, cfg, sessionId, chatId, messageId, body) {
    const key = `${sessionId}:${chatId}`;
    const history = this.history.get(key) ?? [];
    const userText = truncate(body.trim(), cfg.maxInputChars);

    const messages = [];
    if (cfg.systemPrompt && cfg.systemPrompt.trim()) {
      messages.push({ role: 'system', content: cfg.systemPrompt.trim() });
    }
    messages.push(...history, { role: 'user', content: userText });

    const reply = await this.complete(ctx, cfg, messages);
    const formatted = mdToWhatsApp(reply.trim()).trim();
    if (!formatted) throw new Error('AI API returned an empty reply after formatting');

    await ctx.messages.reply(sessionId, chatId, messageId, formatted);

    const next = [...history, { role: 'user', content: userText }, { role: 'assistant', content: formatted }].slice(
      -MAX_HISTORY_MESSAGES,
    );
    this.history.set(key, next);
    while (this.history.size > MAX_TRACKED_CHATS) {
      this.history.delete(this.history.keys().next().value);
    }
  }

  async complete(ctx, cfg, messages) {
    const url = `${cfg.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await ctx.net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        ...(cfg.maxOutputTokens ? { max_tokens: cfg.maxOutputTokens } : {}),
      }),
      timeoutMs: cfg.timeoutMs,
    });

    if (!response.ok) {
      const body = cfg.apiKey ? String(response.body).split(cfg.apiKey).join('***') : String(response.body);
      throw new Error(`AI API failed with status ${response.status}: ${body.slice(0, ERROR_BODY_MAX)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error('AI API returned invalid JSON');
    }

    const text = parsed?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('AI API returned an empty or malformed reply');
    return text;
  }
}

module.exports = {
  default: PersonalAssistant,
  parseConfig,
  matchesOwnerLocally,
  matchesOwnerThroughMapping,
  senderJid,
  phoneOfJid,
  jidKind,
  samePhone,
};
