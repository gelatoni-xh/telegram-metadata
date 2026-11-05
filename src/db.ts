import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Config } from './config.js';

export function createDb(config: Config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    options: '-c statement_timeout=20000 -c lock_timeout=5000',
  });
  const db = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  pools.set(db, pool);
  return db;
}

export type Db = ReturnType<typeof createDb>;
const pools = new WeakMap<PrismaClient, pg.Pool>();

export async function verifyDatabase(db: Db, expected: string) {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (row?.name !== expected) throw new Error('Unexpected database identity');
}

export async function acquireRuntimeLock(db: Db) {
  const client = await pools.get(db)!.connect();
  const result = await client.query('SELECT pg_try_advisory_lock(530016204) AS acquired');
  if (!result.rows[0]?.acquired) {
    client.release();
    throw new Error('Another metadata bot instance is already running');
  }
  client.on('error', () => {
    console.error(JSON.stringify({ event: 'runtime_lock_connection_lost' }));
    process.exit(1);
  });
  return () => client.release();
}
