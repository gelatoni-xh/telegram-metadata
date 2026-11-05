import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    BOT_MODE: z.enum(['webhook', 'polling']).default('webhook'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    EXPECTED_DATABASE: z.string().min(1),
    BOT_TOKEN: z.string().default(''),
    WEBHOOK_SECRET: z.string().default(''),
    WEBHOOK_URL: z.string().url(),
    ADMIN_TELEGRAM_ID: z.union([
      z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)), 'Invalid Telegram user ID'),
      z.literal(''),
    ]).optional().transform(value => value || undefined),
    JAVINFO_API_KEY: z.string().default(''),
    JAVINFO_BASE_URL: z.string().url().default('https://api.javinfo.dev'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(5).default(3),
    QUERY_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  }).parse(env);
}

export type Config = ReturnType<typeof readConfig>;
