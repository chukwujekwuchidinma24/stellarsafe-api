import { sql, type Kysely } from 'kysely';

/**
 * Records which proposals already got a "proposal.expiring" reminder, so restarts and concurrent
 * workers never send twice. No foreign key to `proposals`: reprojection deletes and rebuilds that
 * table, and a rebuild must not trigger a second reminder.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE proposal_expiry_reminders (
      contract_id  text NOT NULL,
      proposal_id  numeric(20, 0) NOT NULL,
      expires_at   timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contract_id, proposal_id)
    );
    CREATE INDEX proposal_expiry_reminders_expires_idx ON proposal_expiry_reminders (expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS proposal_expiry_reminders;`.execute(db);
}
