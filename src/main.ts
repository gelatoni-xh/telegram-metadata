import { readConfig } from './config.js';
import { acquireRuntimeLock, createDb, verifyDatabase } from './db.js';
import { createBot } from './bot.js';
import { createHttp } from './http.js';
import { JavInfoProvider } from './provider.js';
import { startInbox } from './inbox.js';

const config = readConfig();
if (config.NODE_ENV === 'production' && (!/^\d+:[\w-]+$/.test(config.BOT_TOKEN) || config.WEBHOOK_SECRET.length < 32)) {
  throw new Error('Production bot credentials are missing or invalid');
}
if (!config.BOT_TOKEN) throw new Error('BOT_TOKEN is required to start the Telegram bot');

const db = createDb(config);
await verifyDatabase(db, config.EXPECTED_DATABASE);
const releaseLock = await acquireRuntimeLock(db);
const bot = createBot(db, config, new JavInfoProvider(config));
await bot.init();
const commands = [
  { command: 'start', description: '打开首页' },
  { command: 'help', description: '使用帮助' },
  { command: 'language', description: '选择界面语言' },
  { command: 'cancel', description: '取消当前操作' },
  { command: 'privacy', description: '隐私与内容说明' },
];
const japaneseCommands = [
  { command: 'start', description: 'ホームを開く' },
  { command: 'help', description: 'ヘルプ' },
  { command: 'language', description: '表示言語を選択' },
  { command: 'cancel', description: '現在の操作をキャンセル' },
  { command: 'privacy', description: 'プライバシーと内容' },
];
await bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
await bot.api.setMyCommands(japaneseCommands, { scope: { type: 'all_private_chats' }, language_code: 'ja' });
if (config.ADMIN_TELEGRAM_ID) {
  await bot.api.setMyCommands([...commands, { command: 'status', description: '查询上游账户状态' }], {
    scope: { type: 'chat', chat_id: Number(config.ADMIN_TELEGRAM_ID) },
  });
  await bot.api.setMyCommands([...japaneseCommands, { command: 'status', description: '検索元アカウント状態' }], {
    scope: { type: 'chat', chat_id: Number(config.ADMIN_TELEGRAM_ID) },
    language_code: 'ja',
  });
}
const app = createHttp(db, bot, config);
await app.listen({ host: '0.0.0.0', port: config.PORT });
const stopInbox = config.BOT_MODE === 'webhook' ? await startInbox(db, bot) : async () => {};
const cleanupTimer = setInterval(() => {
  void db.querySession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {
    console.error(JSON.stringify({ event: 'session_cleanup_failed' }));
  });
  void db.telegramUpdate.deleteMany({ where: { state: { not: 'queued' }, createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } }).catch(() => {});
}, 10 * 60_000);
cleanupTimer.unref();
if (config.BOT_MODE === 'polling') {
  void bot.start().catch((error: unknown) => console.error(JSON.stringify({ event: 'polling_error', type: error instanceof Error ? error.name : 'unknown' })));
} else if (config.WEBHOOK_SECRET) {
  await bot.api.setWebhook(config.WEBHOOK_URL, { secret_token: config.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
}
console.log(JSON.stringify({ event: 'started', port: config.PORT }));

async function shutdown() {
  clearInterval(cleanupTimer);
  await app.close();
  await stopInbox();
  if (bot.isRunning()) await bot.stop();
  releaseLock();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
