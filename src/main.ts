import { readConfig } from './config.js';
import { acquireRuntimeLock, createDb, verifyDatabase } from './db.js';
import { createBot } from './bot.js';
import { createHttp } from './http.js';
import { JavInfoProvider } from './provider.js';
import { startInbox } from './inbox.js';
import { configureCommands } from './commands.js';
import { startStatsExport } from './stats.js';

async function main() {
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
await configureCommands(bot, config);
const app = createHttp(db, bot, config);
await app.listen({ host: '0.0.0.0', port: config.PORT });
const stopStats = startStatsExport(db, bot.api, config.ADMIN_TELEGRAM_ID);
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
  await stopStats();
  await app.close();
  await stopInbox();
  if (bot.isRunning()) await bot.stop();
  releaseLock();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'startup_failed', type: error instanceof Error ? error.name : 'unknown' }));
  process.exit(1);
});
