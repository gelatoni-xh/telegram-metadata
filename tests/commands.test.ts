import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot, GrammyError } from 'grammy';
import { configureCommands } from '../src/commands.js';

test('new bot can start when administrator has not opened its chat', async () => {
  const bot = new Bot('123456:test-token');
  let publicMenus = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method !== 'setMyCommands') throw new Error('Unexpected request');
    const scope = (payload as { scope?: { type: string } }).scope;
    if (scope?.type === 'chat') {
      throw new GrammyError('chat not found', { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, method, payload);
    }
    publicMenus++;
    return { ok: true, result: true } as never;
  });
  await configureCommands(bot, { ADMIN_TELEGRAM_ID: '100' });
  assert.equal(publicMenus, 2);
});
