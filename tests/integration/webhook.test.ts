import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb, verifyDatabase } from '../../src/db.js';
import { readConfig } from '../../src/config.js';
import { createHttp } from '../../src/http.js';
import { createBot } from '../../src/bot.js';
import { processNextUpdate } from '../../src/inbox.js';
import { collectStats, exportStats } from '../../src/stats.js';
import type { MetadataProvider } from '../../src/provider.js';

test('durable webhook and bilingual bot flow against migrated PostgreSQL', async () => {
  const config = readConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    EXPECTED_DATABASE: 'telegram_metadata_test',
    BOT_TOKEN: '123456:test-token', WEBHOOK_SECRET: 'x'.repeat(40),
    WEBHOOK_URL: 'https://example.invalid/bots/telegram-metadata/webhook',
  });
  const db = createDb(config);
  await verifyDatabase(db, 'telegram_metadata_test');
  // This suite is permitted to reset only its explicitly named test database.
  await db.$executeRawUnsafe('TRUNCATE "UsageEvent", "TelegramUpdate", "QuerySession", "User", "ProviderCall" CASCADE');
  const searches: Parameters<MetadataProvider['search']>[0][] = [];
  const provider: MetadataProvider = {
    search: async input => {
      searches.push(input);
      return { items: [{ providerId: 'ABC-123', code: 'ABC-123', title: 'Fixture title' }],
        ...(input.pageToken ? { previousPageToken: '1' } : { nextPageToken: '2' }) };
    },
    detail: async () => ({ code: 'ABC-123', title: 'Fixture title', maker: 'Fixture studio' }),
    accountStatus: async () => ({ reachable: true }),
  };
  const bot = createBot(db, config, provider, { botInfo: {
    id: 123456, is_bot: true, first_name: 'Test', username: 'TestBot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
    has_topics_enabled: false, allows_users_to_create_topics: false,
    can_manage_bots: false, supports_join_request_queries: false,
  } });
  let last: Record<string, unknown> = {};
  let messageId = 50;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage' || method === 'editMessageText') last = payload as unknown as Record<string, unknown>;
    return { ok: true, result: method === 'answerCallbackQuery' ? true : {
      message_id: ++messageId, date: 1, chat: { id: 100, type: 'private' }, text: String(last.text ?? ''),
    } } as never;
  });
  const app = createHttp(db, bot, config);
  let updateId = 0;
  const from = { id: 100, is_bot: false, first_name: 'Test', language_code: 'zh' };
  const message = (text: string) => ({ message_id: ++messageId, date: 1, chat: { id: 100, type: 'private' }, from,
    text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] } : {}) });
  const deliver = async (body: object, duplicate = false) => {
    const payload = { update_id: ++updateId, ...body };
    const request = { method: 'POST' as const, url: '/bots/telegram-metadata/webhook', payload,
      headers: { 'x-telegram-bot-api-secret-token': config.WEBHOOK_SECRET } };
    assert.equal((await app.inject(request)).statusCode, 200);
    if (duplicate) assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal(await processNextUpdate(db, bot), true);
    assert.equal(await processNextUpdate(db, bot), false);
    const stored = await db.telegramUpdate.findUniqueOrThrow({ where: { updateId } });
    assert.equal(stored.state, 'done');
    assert.equal(stored.payload, null);
  };
  const click = async (data: string) => deliver({ callback_query: { id: String(updateId), from, chat_instance: 'test', data,
    message: { ...message(String(last.text ?? '')), from: { id: 123456, is_bot: true, first_name: 'Test' } } } });
  const button = (prefix: string): string => {
    const keyboard = last.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const action = keyboard.inline_keyboard.flat().find(item => item.callback_data.startsWith(prefix));
    assert.ok(action, `Missing action ${prefix}`);
    return action.callback_data;
  };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/bots/telegram-metadata/webhook', payload: { update_id: 0 } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/bots/telegram-metadata/webhook',
      headers: { 'x-telegram-bot-api-secret-token': config.WEBHOOK_SECRET }, payload: { update_id: 'bad' } })).statusCode, 400);
    await deliver({ message: message('/start') }, true);
    assert.match(String(last.text), /18/);
    await click('age:confirm');
    await deliver({ message: message('ABC-123') }, true);
    assert.equal(searches.length, 1);
    assert.match(String(last.text), /Fixture title/);
    await click(button('page:next:'));
    const session = await db.querySession.findFirstOrThrow();
    assert.equal(session.pageToken, null); // Clear the stale next-page token.
    await click(button('detail:'));
    assert.match(String(last.text), /Fixture studio/);
    await click(button('back:'));
    await click(button('filter:open:'));
    await click(button('filter:sort:'));
    await click(button('filter:field:maker:'));
    await click(button('filter:return:'));
    assert.match(button('filter:sort:'), /^filter:sort:/);
    await click(button('filter:apply:'));
    assert.equal(searches.at(-1)?.filters?.sort, 'release');
    await click('language:ja');
    await deliver({ message: message('ABC-123') });
    assert.match(String(last.text), /検索結果/);
    await click('privacy:reset');
    assert.equal((await db.user.findFirstOrThrow()).ageConfirmedAt, null);
    assert.equal(await db.querySession.count(), 0);
    await deliver({ message: message('ABC-123') });
    assert.match(String(last.text), /18/);
    const events = await db.usageEvent.count();
    assert.equal(events, updateId); // A duplicate webhook does not add an interaction.
    assert.equal(await db.usageEvent.aggregate({ _sum: { searches: true } }).then(r => r._sum.searches), 4);
    const administrator = await collectStats(db, '100');
    assert.equal(administrator.totals.registeredUsers, 0);
    assert.equal(administrator.daily.at(-2)!.active, null); // Before installation is unknown.
    await db.statsState.update({ where: { id: 'usage' }, data: { createdAt: new Date(Date.now() - 15 * 86400_000) } });
    const known = await collectStats(db, '999');
    assert.equal(known.totals.registeredUsers, 1);
    assert.equal(known.daily.at(-1)!.interactions, events);
    assert.equal(known.daily.at(-1)!.active, 1);
    assert.equal(known.daily.at(-1)!.searches, 4);
    assert.equal(known.weeklyActive, 0); // Today is excluded from the completed week.
    await exportStats(db, bot.api, '999');
    assert.ok((await db.statsState.findUniqueOrThrow({ where: { id: 'usage' } })).messageId);
  } finally {
    await app.close();
    await db.$disconnect();
  }
});
