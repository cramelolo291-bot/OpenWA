// Owner-gate tests for the personal-assistant plugin. Run with:
//   node --test plugin-src/personal-assistant/test/
//
// The gate keeps a personal assistant from answering strangers. An @lid sender carries no phone
// number, so the interesting cases are the lid ones: digits must never count as a phone number, the
// gateway's lid<->phone table decides, and every lookup failure must fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../index.js');

const OWNER = '6281234567890';

const rawConfig = {
  apiBaseUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: 'test-key',
  model: 'glm-4.5-flash',
  ownerNumbers: OWNER,
};
const config = plugin.parseConfig(rawConfig);

function message(over = {}) {
  return {
    id: 'msg-1',
    chatId: `${OWNER}@c.us`,
    from: `${OWNER}@c.us`,
    body: 'halo',
    type: 'text',
    fromMe: false,
    isGroup: false,
    ...over,
  };
}

// ── local (no lookup) ─────────────────────────────────────────────────────────────────────────────

test('a phone-dialect JID from the owner matches', () => {
  assert.equal(plugin.matchesOwnerLocally(message(), config), true);
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: `${OWNER}@s.whatsapp.net` }), config), true);
});

test('the local 0… spelling of the owner number matches', () => {
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: '081234567890@c.us', from: '081234567890@c.us' }), config), true);
});

test('an @lid whose digits equal the owner number is not the owner', () => {
  const lidChat = message({ chatId: `${OWNER}@lid`, from: `${OWNER}@lid` });
  assert.equal(plugin.jidKind(lidChat.from), 'lid');
  assert.equal(plugin.senderJid(lidChat), `${OWNER}@lid`);
  assert.equal(plugin.phoneOfJid(lidChat.from), null);
  assert.equal(plugin.matchesOwnerLocally(lidChat, config), false);
});

test('a bare digit string is not a phone identity', () => {
  assert.equal(plugin.jidKind(OWNER), 'unknown');
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: OWNER, from: OWNER }), config), false);
});

test('cache-only phone hints are not trusted', () => {
  const lidChat = message({
    chatId: '999888777@lid',
    from: '999888777@lid',
    senderPhone: OWNER,
    contact: { number: OWNER },
  });
  assert.equal(plugin.matchesOwnerLocally(lidChat, config), false);
});

test('an explicitly allowlisted lid matches, and only that lid', () => {
  const withLids = plugin.parseConfig({ ...rawConfig, ownerLids: '123456789' });
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: '123456789@lid', from: '123456789@lid' }), withLids), true);
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: '987654321@lid', from: '987654321@lid' }), withLids), false);
});

test('a stranger is never the owner', () => {
  assert.equal(plugin.matchesOwnerLocally(message({ chatId: '628111111111@c.us', from: '628111111111@c.us' }), config), false);
});

// ── hook-level behaviour, including the lid mapping ───────────────────────────────────────────────

function fakeContext({ canonicalChatId, configOverride } = {}) {
  const replies = [];
  const fetched = [];
  let handler;
  const ctx = {
    config: { ...rawConfig, ...configOverride },
    logger: { log() {}, warn() {}, error() {}, debug: () => {} },
    registerHook: (event, fn) => {
      if (event === 'message:received') handler = fn;
    },
    engine: canonicalChatId ? { canonicalChatId } : undefined,
    messages: { reply: async (sessionId, chatId, messageId, text) => replies.push({ sessionId, chatId, messageId, text }) },
    net: {
      fetch: async (url, options) => {
        fetched.push({ url, options });
        return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Halo, saya asistennya.' } }] }) };
      },
    },
  };
  return { ctx, replies, fetched, fire: (data) => handler({ source: 'Engine', sessionId: 'sess-1', data }) };
}

async function settle() {
  for (let i = 0; i < 50; i += 1) await new Promise(resolve => setTimeout(resolve, 2));
}

test('a mapped @lid chat reaches the owner and is answered', async () => {
  const { ctx, replies, fire } = fakeContext({
    canonicalChatId: async (_sessionId, chatId) => (chatId === '555000111@lid' ? `${OWNER}@c.us` : chatId),
  });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  const result = await fire(message({ chatId: '555000111@lid', from: '555000111@lid' }));
  assert.equal(result.continue, false);
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].chatId, '555000111@lid');
});

test('an @lid the mapping cannot resolve is ignored and the chain continues', async () => {
  const { ctx, replies, fetched, fire } = fakeContext({ canonicalChatId: async (_s, chatId) => chatId });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  const result = await fire(message({ chatId: '777000111@lid', from: '777000111@lid' }));
  assert.equal(result.continue, true);
  await settle();
  assert.equal(fetched.length, 0);
  assert.equal(replies.length, 0);
});

test('a failing lid lookup fails closed', async () => {
  const { ctx, replies, fetched, fire } = fakeContext({
    canonicalChatId: async () => {
      throw new Error('engine not ready');
    },
  });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  const result = await fire(message({ chatId: '888000111@lid', from: '888000111@lid' }));
  assert.equal(result.continue, true);
  await settle();
  assert.equal(fetched.length, 0);
  assert.equal(replies.length, 0);
});

test('a phone message from a stranger is ignored', async () => {
  const { ctx, replies, fire } = fakeContext({ canonicalChatId: async (_s, chatId) => chatId });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  const result = await fire(message({ chatId: '628111111111@c.us', from: '628111111111@c.us' }));
  assert.equal(result.continue, true);
  await settle();
  assert.equal(replies.length, 0);
});

test('in a group the participant is judged, not the group id', async () => {
  const group = '120363000000000000@g.us';
  const { ctx, replies, fire } = fakeContext({
    canonicalChatId: async (_s, chatId) => (chatId === '444000111@lid' ? `${OWNER}@c.us` : chatId),
    configOverride: { respondInGroups: true },
  });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  // A stranger's lid in the group resolves to someone else: ignored.
  const stranger = await fire(
    message({ id: 'g1', isGroup: true, chatId: group, from: group, author: '444000222@lid' }),
  );
  assert.equal(stranger.continue, true);

  // The owner's lid in the same group is answered.
  const owner = await fire(message({ id: 'g2', isGroup: true, chatId: group, from: group, author: '444000111@lid' }));
  assert.equal(owner.continue, false);

  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].chatId, group);
});

test('group replies stay off unless enabled, even for the owner', async () => {
  const group = '120363000000000999@g.us';
  const { ctx, replies, fire } = fakeContext({ canonicalChatId: async (_s, chatId) => chatId });
  const assistant = new plugin.default();
  await assistant.onEnable(ctx);

  const result = await fire(message({ isGroup: true, chatId: group, from: group, author: `${OWNER}@c.us` }));
  assert.equal(result.continue, true);
  await settle();
  assert.equal(replies.length, 0);
});
