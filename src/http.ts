import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Bot } from 'grammy';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { verifyDatabase } from './db.js';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

const updateSchema = z.object({ update_id: z.number().int().nonnegative().max(2147483647) }).passthrough();

export function createHttp(db: Db, bot: Bot, config: Config) {
  const app = Fastify({ bodyLimit: 1024 * 1024, logger: false, requestTimeout: 25000 });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await verifyDatabase(db, config.EXPECTED_DATABASE);
      await db.user.count();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.post('/bots/telegram-metadata/webhook', async (request, reply) => {
    const supplied = request.headers['x-telegram-bot-api-secret-token'];
    if (typeof supplied !== 'string' || !config.WEBHOOK_SECRET || Buffer.byteLength(supplied) !== Buffer.byteLength(config.WEBHOOK_SECRET) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(config.WEBHOOK_SECRET))) {
      return reply.code(403).send({ ok: false });
    }
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false });
    try {
      await db.telegramUpdate.createMany({
        data: [{ updateId: parsed.data.update_id, payload: parsed.data as Prisma.InputJsonObject }],
        skipDuplicates: true,
      });
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  return app;
}
