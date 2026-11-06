import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { SecretBox } from '../../src/lib/crypto.js';
import { createLogger } from '../../src/lib/logger.js';
import { NotificationDispatcher } from '../../src/modules/notifications/dispatcher.js';
import { renderEmail } from '../../src/modules/notifications/formats.js';
import { queueExpiryReminders } from '../../src/modules/notifications/reminders.js';
import { sendWebhook } from '../../src/modules/notifications/sender.js';
import { createWorkers, runMaintenance } from '../../src/workers.js';
import { reprojectTreasury } from '../../src/indexer/reproject.js';
import { createTestApp, login, type TestApp } from '../helpers/app.js';
import { createTestDatabase, truncateAll, type TestDatabase } from '../helpers/db.js';
import { EventFactory, randomAccount, randomContractId } from '../helpers/events.js';

let tdb: TestDatabase;
let t: TestApp;
let server: Server;
let hookUrl: string;
let received: { body: string; event: string | undefined }[] = [];
const log = createLogger('silent', false);
const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  tdb = await createTestDatabase();
  t = await createTestApp(tdb.db, tdb.url);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ body, event: req.headers['x-stellarsafe-event'] as string | undefined });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await t.app.close();
  await tdb.destroy();
});
beforeEach(async () => {
  await truncateAll(tdb.db);
  t.chain.events = [];
  received = [];
});

const dispatcher = () =>
  new NotificationDispatcher(tdb.db, new SecretBox(t.config.SECRETS_ENCRYPTION_KEY), sendWebhook, log, {
    pollIntervalMs: 10,
    maxAttempts: 3,
    timeoutMs: 2_000,
    disableAfterFailures: 2,
    allowPrivateTargets: true,
    publicUrl: t.config.PUBLIC_URL,
  });

const indexAll = async () => {
  const ix = new Indexer(tdb.db, t.chain, log, { windowLedgers: 10_000, pollIntervalMs: 1 });
  while ((await ix.tick()).behind);
};

async function flush() {
  const d = dispatcher();
  await d.fanOut();
  await d.deliverDue();
}

const expiringRows = () =>
  tdb.db
    .selectFrom('notification_outbox')
    .select(['contract_id', 'payload'])
    .where('event_type', '=', 'proposal.expiring')
    .execute();

/** A treasury with one member and proposals expiring at the given offsets (in hours) from now. */
async function setup(expiresInHours: number[]) {
  const member = await login(t.app);
  const id = randomContractId();
  t.chain.wasmHashes.set(id, 'aa'.repeat(32));
  await t.app.inject({
    method: 'POST',
    url: '/treasuries',
    headers: member.headers,
    payload: { contractId: id, startLedger: 1 },
  });
  const f = new EventFactory(id, 10);
  t.chain.latestLedger = 100;
  t.chain.events.push(f.init([member.account], 1));
  expiresInHours.forEach((h, i) =>
    t.chain.events.push(
      f.proposed({
        id: i + 1,
        proposer: member.account,
        recipient: randomAccount(),
        token: randomContractId(),
        amount: 5_000_000_000n,
        expiresAt: nowSec() + Math.round(h * HOUR),
      }),
    ),
  );
  await indexAll();
  return { id, f, member };
}

describe('proposal expiry reminders', () => {
  it('queues exactly one reminder per proposal, even across repeated runs and restarts', async () => {
    const { id } = await setup([2]);
    expect(await queueExpiryReminders(tdb.db, 24)).toBe(1);
    expect(await queueExpiryReminders(tdb.db, 24)).toBe(0);
    // Concurrent workers race for the same proposal: still one row.
    await Promise.all([queueExpiryReminders(tdb.db, 24), queueExpiryReminders(tdb.db, 24)]);

    const rows = await expiringRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contract_id).toBe(id);
    expect(rows[0]!.payload).toMatchObject({
      type: 'proposal.expiring',
      treasuryId: id,
      data: { id: '1', amount: '5000000000', approvals: 0, required_approvals: 2 },
    });
    const data = (rows[0]!.payload as { data: { expires_at: string } }).data;
    expect(data.expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('does not remind again after the treasury is reprojected', async () => {
    const { id } = await setup([2]);
    expect(await queueExpiryReminders(tdb.db, 24)).toBe(1);
    await reprojectTreasury(tdb.db, id);
    expect(await queueExpiryReminders(tdb.db, 24)).toBe(0);
  });

  it('skips executed and cancelled proposals', async () => {
    const { f, member } = await setup([2, 3, 4]);
    t.chain.latestLedger = 200;
    f.ledger = 150;
    t.chain.events.push(f.executed(1, member.account), f.cancelled(2, member.account));
    await indexAll();

    expect(await queueExpiryReminders(tdb.db, 24)).toBe(1);
    const rows = await expiringRows();
    expect(rows.map((r) => (r.payload as { data: { id: string } }).data.id)).toEqual(['3']);
  });

  it('skips proposals outside the window, and already-expired ones', async () => {
    await setup([48, -1]);
    expect(await queueExpiryReminders(tdb.db, 24)).toBe(0);
    // Widening the window picks up the 48h one but never the expired one.
    expect(await queueExpiryReminders(tdb.db, 72)).toBe(1);
    expect(await queueExpiryReminders(tdb.db, 0)).toBe(0);
  });

  it('delivers to Slack subscribers with a readable summary', async () => {
    const { member } = await setup([2]);
    const sub = await t.app.inject({
      method: 'POST',
      url: '/notifications/preferences',
      headers: member.headers,
      payload: { url: `${hookUrl}/slack`, format: 'slack', eventTypes: ['proposal.expiring'] },
    });
    expect(sub.statusCode).toBe(201);

    await queueExpiryReminders(tdb.db, 24);
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('proposal.expiring');
    expect(JSON.parse(received[0]!.body).text).toMatch(
      /^\[StellarSafe\] Proposal #1 in treasury C.{3}….{4} expires at \d{4}-.*Z \(0\/2 approvals\)/,
    );
  });

  it('renders an email for the event', async () => {
    const { id } = await setup([2]);
    await queueExpiryReminders(tdb.db, 24);
    const [row] = await expiringRows();
    const mail = renderEmail('proposal.expiring', row!.payload, {
      publicUrl: t.config.PUBLIC_URL,
      unsubscribeToken: 'tok',
    });
    expect(mail.subject).toMatch(/Proposal #1 .* expires at/);
    expect(mail.text).toContain(`Treasury: ${id}`);
    expect(mail.headers['X-StellarSafe-Event']).toBe('proposal.expiring');
  });

  it('runs from the worker and prunes old claims during maintenance', async () => {
    await setup([2]);
    const workers = createWorkers(t.config, tdb.db, t.chain, log);
    workers.start();
    for (let i = 0; i < 100 && (await expiringRows()).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await workers.stop();
    expect(await expiringRows()).toHaveLength(1);

    await sql`UPDATE proposal_expiry_reminders SET expires_at = now() - interval '2 days'`.execute(tdb.db);
    await runMaintenance(tdb.db);
    expect(await tdb.db.selectFrom('proposal_expiry_reminders').selectAll().execute()).toHaveLength(0);
  });
});
