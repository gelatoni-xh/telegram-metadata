import { GrammyError, type Api, type Context } from 'grammy';
import type { Db } from './db.js';

const dayMs = 86_400_000, offset = 8 * 3_600_000;
const date = (time: number) => new Date(time + offset).toISOString().slice(0, 10);
export const statsPrefix = 'Telegram Metadata · Daily statistics export\n';
type UsageContext = Context & { usageSearches?: number };
export function markSearch(ctx: Context) {
  const usage = ctx as UsageContext;
  usage.usageSearches = (usage.usageSearches ?? 0) + 1;
}
export async function recordUsage(db: Db, ctx: Context) {
  await db.usageEvent.upsert({ where: { updateId: ctx.update.update_id },
    create: { updateId: ctx.update.update_id, telegramUserId: BigInt(ctx.from!.id), searches: (ctx as UsageContext).usageSearches ?? 0 },
    update: {},
  });
}

export async function collectStats(db: Db, adminId: string, now = new Date()) {
  const end = Math.floor((now.getTime() + offset) / dayMs) * dayMs - offset;
  const start = new Date(end - 14 * dayMs), tomorrow = new Date(end + dayMs), admin = BigInt(adminId);
  const snapshot = await db.$transaction(async tx => {
    const state = await tx.statsState.findUniqueOrThrow({ where: { id: 'usage' } });
    const registeredUsers = await tx.user.count({ where: { telegramUserId: { not: admin } } });
    const newly = await tx.$queryRaw<Array<{day: string; n: bigint}>>`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day, count(*) AS n
      FROM "User" WHERE "telegramUserId" <> ${admin} AND "createdAt" >= ${start} AND "createdAt" < ${tomorrow} GROUP BY 1`;
    const activity = await tx.$queryRaw<Array<{day: string; active: bigint; interactions: bigint; searches: bigint}>>`
      SELECT to_char(e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
      count(DISTINCT e."telegramUserId") AS active, count(*) AS interactions, sum(e.searches) AS searches
      FROM "UsageEvent" e JOIN "User" u ON u."telegramUserId"=e."telegramUserId"
      WHERE e."telegramUserId" <> ${admin} AND e."createdAt" >= ${start} AND e."createdAt" < ${tomorrow} GROUP BY 1`;
    const [week] = await tx.$queryRaw<Array<{n: bigint}>>`
      SELECT count(DISTINCT e."telegramUserId") AS n FROM "UsageEvent" e JOIN "User" u ON u."telegramUserId"=e."telegramUserId"
      WHERE e."telegramUserId" <> ${admin} AND e."createdAt" >= ${new Date(end - 7 * dayMs)} AND e."createdAt" < ${new Date(end)}`;
    return { state, registeredUsers, newly, activity, weekly: Number(week!.n) };
  }, { isolationLevel: 'RepeatableRead' });
  const tracking = snapshot.state.createdAt.getTime();
  const daily = Array.from({ length: 15 }, (_, i) => {
    const timestamp = end + (i - 14) * dayMs, day = date(timestamp);
    const row = snapshot.activity.find(row => row.day === day);
    // A partial installation day is incomplete too. Never turn missing history into zero.
    const complete = tracking <= timestamp;
    return { day, newUsers: Number(snapshot.newly.find(row => row.day === day)?.n ?? 0),
      active: complete ? Number(row?.active ?? 0) : null,
      interactions: complete ? Number(row?.interactions ?? 0) : null,
      searches: complete ? Number(row?.searches ?? 0) : null };
  });
  return { version: 1, service: 'telegram-metadata', timezone: 'Asia/Shanghai', generatedAt: now.toISOString(),
    reportDate: date(end - dayMs), trackingSince: snapshot.state.createdAt.toISOString(),
    totals: { registeredUsers: snapshot.registeredUsers },
    weeklyActive: tracking <= end - 7 * dayMs ? snapshot.weekly : null, daily };
}

export async function exportStats(db: Db, api: Pick<Api, 'sendMessage' | 'editMessageText' | 'pinChatMessage'>, adminId: string) {
  const report = await collectStats(db, adminId);
  const state = await db.statsState.findUniqueOrThrow({ where: { id: 'usage' } });
  let messageId = state.messageId;
  const text = statsPrefix + JSON.stringify(report);
  if (text.length > 4096) throw new Error('Statistics export exceeds Telegram message limit');
  if (messageId) {
    try { await api.editMessageText(adminId, messageId, text); }
    catch (error) {
      if (error instanceof GrammyError && error.error_code === 400 && error.description.includes('message is not modified')) { /* unchanged */ }
      else if (error instanceof GrammyError && error.error_code === 400 && error.description.includes('message to edit not found')) messageId = null;
      else throw error;
    }
  }
  if (!messageId) {
    const message = await api.sendMessage(adminId, text, { disable_notification: true, protect_content: true });
    messageId = message.message_id;
    await db.statsState.update({ where: { id: 'usage' }, data: { messageId } });
  }
  await api.pinChatMessage(adminId, messageId, { disable_notification: true });
}

export function startStatsExport(db: Db, api: Pick<Api, 'sendMessage' | 'editMessageText' | 'pinChatMessage'>, adminId?: string) {
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (!adminId || pending) return;
    pending = exportStats(db, api, adminId).catch(() => {
      console.error(JSON.stringify({ event: 'statistics_export_failed' }));
    }).finally(() => { pending = undefined; });
  };
  tick();
  const timer = setInterval(tick, 5 * 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
