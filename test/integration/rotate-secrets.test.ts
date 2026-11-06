import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SecretBox } from '../../src/lib/crypto.js';
import { rotateSecrets } from '../../src/modules/notifications/rotate-secrets.js';
import { EMAIL_VERIFICATION_EVENT } from '../../src/modules/notifications/service.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { randomAccount } from '../helpers/events.js';

const oldKey = Buffer.alloc(32, 1).toString('base64');
const newKey = Buffer.alloc(32, 2).toString('base64');
const oldBox = new SecretBox(oldKey);
const newBox = new SecretBox(newKey);
const rotating = new SecretBox(newKey, oldKey);

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());
beforeEach(() => truncateAll(tdb.db));

async function addSub(channel: 'webhook' | 'email', secret: string | null) {
  const id = randomUUID();
  await tdb.db
    .insertInto('notification_subscriptions')
    .values({
      id,
      account: randomAccount(),
      contract_id: null,
      channel,
      format: 'json',
      url: channel === 'webhook' ? 'https://hooks.example/x' : null,
      secret_encrypted: secret,
      email: channel === 'email' ? 'a@example.com' : null,
      verified_at: null,
      verification_token_hash: null,
      verification_expires_at: null,
      event_types: [],
      disabled_reason: null,
    })
    .execute();
  return id;
}

async function addVerification(subscriptionId: string, tokenSealed: string, status: 'pending' | 'succeeded') {
  const id = randomUUID();
  await tdb.db
    .insertInto('notification_deliveries')
    .values({
      id,
      subscription_id: subscriptionId,
      outbox_id: null,
      event_type: EMAIL_VERIFICATION_EVENT,
      payload: JSON.stringify({ type: EMAIL_VERIFICATION_EVENT, tokenSealed }),
      status,
      last_status_code: null,
      last_error: null,
      lease_expires_at: null,
      delivered_at: null,
    })
    .execute();
  return id;
}

const secretOf = async (id: string) =>
  (
    await tdb.db
      .selectFrom('notification_subscriptions')
      .select('secret_encrypted')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  ).secret_encrypted!;
const tokenOf = async (id: string) =>
  (
    (
      await tdb.db
        .selectFrom('notification_deliveries')
        .select('payload')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).payload as { tokenSealed: string }
  ).tokenSealed;

it('re-encrypts old-key values with the current key and is idempotent', async () => {
  const oldSub = await addSub('webhook', oldBox.seal('whsec_old'));
  const newSub = await addSub('webhook', newBox.seal('whsec_new'));
  await addSub('email', null);
  const emailSub = await addSub('email', null);
  const pending = await addVerification(emailSub, oldBox.seal('tok_pending'), 'pending');
  const sent = await addVerification(emailSub, oldBox.seal('tok_sent'), 'succeeded');
  const sentBefore = await tokenOf(sent);

  const first = await rotateSecrets(tdb.db, rotating);
  expect(first.subscriptions).toEqual({ rotated: 1, current: 1, skipped: 0, failed: [] });
  expect(first.verifications).toEqual({ rotated: 1, current: 0, skipped: 0, failed: [] });

  // Readable without the previous key now.
  expect(newBox.open(await secretOf(oldSub))).toBe('whsec_old');
  expect(newBox.open(await secretOf(newSub))).toBe('whsec_new');
  expect(newBox.open(await tokenOf(pending))).toBe('tok_pending');
  expect(await tokenOf(sent)).toBe(sentBefore);

  const second = await rotateSecrets(tdb.db, rotating);
  expect(second.subscriptions).toMatchObject({ rotated: 0, current: 2 });
  expect(second.verifications).toMatchObject({ rotated: 0, current: 1 });
});

it('reports values neither key can open and leaves them untouched', async () => {
  const foreign = new SecretBox(Buffer.alloc(32, 3).toString('base64')).seal('whsec_x');
  const id = await addSub('webhook', foreign);
  const result = await rotateSecrets(tdb.db, rotating);
  expect(result.subscriptions.failed).toEqual([id]);
  expect(await secretOf(id)).toBe(foreign);
});
