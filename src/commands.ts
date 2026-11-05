import type { Bot } from 'grammy';
import type { Config } from './config.js';

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

export async function configureAdministratorCommands(bot: Bot, config: Pick<Config, 'ADMIN_TELEGRAM_ID'>) {
  if (!config.ADMIN_TELEGRAM_ID) return;
  try {
    const scope = { type: 'chat' as const, chat_id: Number(config.ADMIN_TELEGRAM_ID) };
    await bot.api.setMyCommands([...commands, { command: 'status', description: '查询上游账户状态' }, { command: 'stats', description: '查看使用统计' }], { scope });
    await bot.api.setMyCommands([...japaneseCommands, { command: 'status', description: '検索元アカウント状態' }, { command: 'stats', description: '利用統計' }], { scope, language_code: 'ja' });
  } catch {
    // Telegram cannot assign a per-chat menu until the user opens this new bot.
    // /status authorization is independent of menu registration.
    console.error(JSON.stringify({ event: 'administrator_menu_deferred' }));
  }
}

export async function configureCommands(bot: Bot, config: Pick<Config, 'ADMIN_TELEGRAM_ID'>) {
  await bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } });
  await bot.api.setMyCommands(japaneseCommands, { scope: { type: 'all_private_chats' }, language_code: 'ja' });
  await configureAdministratorCommands(bot, config);
}
