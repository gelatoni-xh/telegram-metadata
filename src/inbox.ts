import { Prisma } from '@prisma/client';
import type { Bot } from 'grammy';
import type { Db } from './db.js';

export async function processNextUpdate(db: Db, bot: Bot): Promise<boolean> {
  const [entry] = await db.$queryRaw<Array<{ updateId: number; payload: unknown }>>`
    UPDATE "TelegramUpdate" SET state = 'processing'
    WHERE "updateId" = (
      SELECT "updateId" FROM "TelegramUpdate" WHERE state = 'queued'
      ORDER BY "updateId" LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING "updateId", payload`;
  if (!entry) return false;
  let state = 'done';
  try {
    await bot.handleUpdate(entry.payload as Parameters<typeof bot.handleUpdate>[0]);
  } catch {
    state = 'failed';
    console.error(JSON.stringify({ event: 'update_processing_failed', updateId: entry.updateId }));
  }
  // Keep only the ID for deduplication; remove private message text immediately.
  await db.telegramUpdate.update({ where: { updateId: entry.updateId }, data: { state, payload: Prisma.DbNull } });
  return true;
}

export async function startInbox(db: Db, bot: Bot) {
  // A crashed in-flight request may already have incurred an upstream charge.
  // Never automatically replay it. Unclaimed queued requests survive restarts.
  await db.telegramUpdate.updateMany({ where: { state: 'processing' }, data: { state: 'interrupted', payload: Prisma.DbNull } });
  let stopping = false;
  let wake: (() => void) | undefined;
  const run = (async () => {
    while (!stopping) {
      try {
        if (await processNextUpdate(db, bot)) continue;
      } catch {
        console.error(JSON.stringify({ event: 'inbox_database_error' }));
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 200);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  })();
  return async () => { stopping = true; wake?.(); await run; };
}
