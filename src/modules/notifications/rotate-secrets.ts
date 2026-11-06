import { sql } from 'kysely';
import type { DB } from '../../db/index.js';
import type { SecretBox } from '../../lib/crypto.js';
import { EMAIL_VERIFICATION_EVENT } from './service.js';

export interface RotationStats {
  /** Values re-sealed with the current key. */
  rotated: number;
  /** Values already sealed with the current key. */
  current: number;
  /** Values changed by someone else mid-rotation (they are sealed with the current key). */
  skipped: number;
  /** Ids of values neither key could open. */
  failed: string[];
}

const emptyStats = (): RotationStats => ({ rotated: 0, current: 0, skipped: 0, failed: [] });

function tryReseal(box: SecretBox, sealed: string): string | null | Error {
  try {
    return box.reseal(sealed);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Re-encrypts every value sealed by the SecretBox with its current key:
 * webhook signing secrets and the tokens in queued email-verification deliveries.
 *
 * Safe to run while the API and worker are up. Each row is updated only if it still holds the
 * value that was read, so a concurrent `rotate-secret` call is never overwritten. Idempotent.
 */
export async function rotateSecrets(
  db: DB,
  box: SecretBox,
): Promise<{ subscriptions: RotationStats; verifications: RotationStats }> {
  const subscriptions = emptyStats();
  const subs = await db
    .selectFrom('notification_subscriptions')
    .select(['id', 'secret_encrypted'])
    .where('secret_encrypted', 'is not', null)
    .execute();
  for (const { id, secret_encrypted } of subs) {
    const next = tryReseal(box, secret_encrypted!);
    if (next instanceof Error) subscriptions.failed.push(id);
    else if (next === null) subscriptions.current++;
    else {
      const res = await db
        .updateTable('notification_subscriptions')
        .set({ secret_encrypted: next })
        .where('id', '=', id)
        .where('secret_encrypted', '=', secret_encrypted)
        .executeTakeFirst();
      if (res.numUpdatedRows > 0n) subscriptions.rotated++;
      else subscriptions.skipped++;
    }
  }

  // Delivered or dead verification emails are never opened again, so only queued ones matter.
  const verifications = emptyStats();
  const deliveries = await db
    .selectFrom('notification_deliveries')
    .select(['id', 'payload'])
    .where('event_type', '=', EMAIL_VERIFICATION_EVENT)
    .where('status', 'in', ['pending', 'in_flight'])
    .execute();
  for (const { id, payload } of deliveries) {
    const sealed = (payload as { tokenSealed?: unknown } | null)?.tokenSealed;
    if (typeof sealed !== 'string') {
      verifications.failed.push(id);
      continue;
    }
    const next = tryReseal(box, sealed);
    if (next instanceof Error) verifications.failed.push(id);
    else if (next === null) verifications.current++;
    else {
      const res = await db
        .updateTable('notification_deliveries')
        .set({ payload: JSON.stringify({ ...(payload as object), tokenSealed: next }) })
        .where('id', '=', id)
        .where(sql<string>`payload->>'tokenSealed'`, '=', sealed)
        .executeTakeFirst();
      if (res.numUpdatedRows > 0n) verifications.rotated++;
      else verifications.skipped++;
    }
  }

  return { subscriptions, verifications };
}
