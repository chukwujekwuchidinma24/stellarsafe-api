import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type DB } from '../../src/db/index.js';
import { migrateToLatest } from '../../src/db/migrator.js';

export interface TestDatabase {
  db: DB;
  url: string;
  destroy(): Promise<void>;
}

/** A fresh, migrated database per test file, so files can run in parallel. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const db = createDb({ connectionString: url, max: 5 });
  await migrateToLatest(db);

  return {
    db,
    url,
    async destroy() {
      await db.destroy();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function truncateAll(db: DB): Promise<void> {
  await sql`
    TRUNCATE notification_deliveries, notification_outbox, proposal_expiry_reminders, notification_subscriptions, activity, chain_events,
      proposal_metadata, proposal_approvals, proposals, treasury_recipients, treasury_members, treasuries,
      refresh_tokens, auth_challenges RESTART IDENTITY CASCADE
  `.execute(db);
}
