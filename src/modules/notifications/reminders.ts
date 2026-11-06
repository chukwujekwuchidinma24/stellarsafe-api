import { sql } from 'kysely';
import type { DB } from '../../db/index.js';

export const PROPOSAL_EXPIRING_EVENT = 'proposal.expiring' as const;

/**
 * Writes one `proposal.expiring` outbox row for each pending proposal that expires within
 * `windowHours`. The claim (`proposal_expiry_reminders`) and the outbox row are written in one
 * statement, and the claim's primary key makes it at-most-once across restarts and concurrent
 * workers. Already-expired proposals are skipped. Returns the number of reminders queued.
 */
export async function queueExpiryReminders(db: DB, windowHours: number, now = new Date()): Promise<number> {
  if (windowHours <= 0) return 0;
  const until = new Date(now.getTime() + windowHours * 3600_000);
  const result = await sql`
    WITH due AS (
      INSERT INTO proposal_expiry_reminders (contract_id, proposal_id, expires_at)
      SELECT p.contract_id, p.proposal_id, p.expires_at
      FROM proposals p
      WHERE p.status = 'pending' AND p.expires_at > ${now} AND p.expires_at <= ${until}
      ON CONFLICT (contract_id, proposal_id) DO NOTHING
      RETURNING contract_id, proposal_id
    )
    INSERT INTO notification_outbox (contract_id, event_type, payload)
    SELECT p.contract_id, ${PROPOSAL_EXPIRING_EVENT},
      jsonb_build_object(
        'type', ${PROPOSAL_EXPIRING_EVENT}::text,
        'treasuryId', p.contract_id,
        'occurredAt', to_char(${now}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'data', jsonb_build_object(
          'id', p.proposal_id::text,
          'proposer', p.proposer,
          'recipient', p.recipient,
          'token', p.token,
          'amount', p.amount::text,
          'approvals', p.approvals_count,
          'required_approvals', p.required_approvals,
          'expires_at', to_char(p.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )
      )
    FROM due JOIN proposals p USING (contract_id, proposal_id)
    ORDER BY p.expires_at
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** Drops reminder claims for proposals that expired more than a day ago; they can never fire again. */
export async function pruneExpiryReminders(db: DB, now = new Date()): Promise<void> {
  await db
    .deleteFrom('proposal_expiry_reminders')
    .where('expires_at', '<', new Date(now.getTime() - 86_400_000))
    .execute();
}
