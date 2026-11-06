import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../db/index.js';
import type { Database, Subscription } from '../../db/schema.js';
import { randomToken, sha256Hex, type SecretBox } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import type { TreasuryService } from '../treasuries/service.js';
import type { WebhookFormat } from './formats.js';
import { assertWebhookUrl } from './ssrf.js';

const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
const VERIFICATION_TTL_MS = 24 * 3600_000;
/** Accounts are free to create, so cap confirmation emails per *address* across all accounts. */
const MAX_VERIFICATION_EMAILS_PER_ADDRESS_PER_DAY = 3;
export const EMAIL_VERIFICATION_EVENT = 'email.verification';
const deliveriesCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface CreateSubscriptionInput {
  channel: 'webhook' | 'email';
  url?: string | undefined;
  email?: string | undefined;
  format: WebhookFormat;
  treasuryId?: string | null | undefined;
  eventTypes: string[];
}

export interface UpdateSubscriptionInput {
  url?: string | undefined;
  format?: WebhookFormat | undefined;
  eventTypes?: string[] | undefined;
  enabled?: boolean | undefined;
}

export const unsubscribeTokenFor = (box: SecretBox, subscriptionId: string) =>
  `${subscriptionId}.${box.mac('unsubscribe', subscriptionId)}`;

export class NotificationService {
  constructor(
    private readonly db: DB,
    private readonly treasuries: TreasuryService,
    private readonly box: SecretBox,
    private readonly config: Config,
  ) {}

  private get urlPolicy() {
    return { allowPrivate: this.config.NOTIFY_ALLOW_PRIVATE_TARGETS, requireHttps: this.config.isProduction };
  }

  async list(account: string) {
    const rows = await this.db
      .selectFrom('notification_subscriptions')
      .selectAll()
      .where('account', '=', account)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toDto);
  }

  async create(account: string, input: CreateSubscriptionInput) {
    if (input.channel === 'webhook') {
      if (!input.url) throw badRequest('url is required for webhook subscriptions');
      assertWebhookUrl(input.url, this.urlPolicy);
    } else {
      if (!input.email) throw badRequest('email is required for email subscriptions');
      if (!this.config.SMTP_URL) throw badRequest('Email notifications are not enabled on this server');
    }
    if (input.treasuryId) await this.treasuries.assertMember(input.treasuryId, account);

    const count = await this.db
      .selectFrom('notification_subscriptions')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('account', '=', account)
      .executeTakeFirstOrThrow();
    if (Number(count.c) >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
      throw badRequest(`At most ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} subscriptions per account`);
    }

    const base = {
      id: randomUUID(),
      account,
      contract_id: input.treasuryId ?? null,
      event_types: [...new Set(input.eventTypes)],
      created_at: new Date(),
      updated_at: new Date(),
    };

    if (input.channel === 'email') {
      const row = await this.db.transaction().execute(async (tx) => {
        const created = await tx
          .insertInto('notification_subscriptions')
          .values({ ...base, channel: 'email', format: 'json', email: input.email!.toLowerCase() })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.queueVerification(tx, created.id);
        return created;
      });
      return toDto(row);
    }

    const secret = `whsec_${randomToken(32)}`;
    const row = await this.db
      .insertInto('notification_subscriptions')
      .values({
        ...base,
        channel: 'webhook',
        format: input.format,
        url: input.url!,
        secret_encrypted: this.box.seal(secret),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toDto(row), secret };
  }

  /**
   * Issues a fresh single-use verification token and queues the confirmation email through the
   * dispatcher (so it gets retries). Only the token hash is stored on the subscription; the
   * plaintext travels sealed inside the delivery payload.
   */
  private async queueVerification(tx: Kysely<Database>, subscriptionId: string): Promise<void> {
    const sub = await tx
      .selectFrom('notification_subscriptions')
      .select('email')
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    // Serialise per address so concurrent sign-ups can't race past the cap.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'verify:' + sub.email}))`.execute(tx);
    const recent = await tx
      .selectFrom('notification_deliveries as d')
      .innerJoin('notification_subscriptions as s', 's.id', 'd.subscription_id')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('s.email', '=', sub.email)
      .where('d.event_type', '=', EMAIL_VERIFICATION_EVENT)
      .where('d.created_at', '>', new Date(Date.now() - 24 * 3600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.c) >= MAX_VERIFICATION_EMAILS_PER_ADDRESS_PER_DAY) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many confirmation emails sent to this address today');
    }
    const token = randomToken(32);
    await tx
      .updateTable('notification_subscriptions')
      .set({
        verification_token_hash: sha256Hex(token),
        verification_expires_at: new Date(Date.now() + VERIFICATION_TTL_MS),
      })
      .where('id', '=', subscriptionId)
      .execute();
    await tx
      .insertInto('notification_deliveries')
      .values({
        id: randomUUID(),
        subscription_id: subscriptionId,
        outbox_id: null,
        event_type: EMAIL_VERIFICATION_EVENT,
        payload: JSON.stringify({ type: EMAIL_VERIFICATION_EVENT, tokenSealed: this.box.seal(token) }),
        created_at: new Date(),
      })
      .execute();
  }

  async resendVerification(account: string, id: string) {
    const sub = await this.own(account, id);
    if (sub.channel !== 'email') throw badRequest('Only email subscriptions need verification');
    if (sub.verified_at) throw conflict('Email is already verified');
    await this.db.transaction().execute((tx) => this.queueVerification(tx, sub.id));
    return { queued: true as const };
  }

  /** Confirms an email address. The token is the credential; no session is required. */
  async verifyEmail(token: string): Promise<boolean> {
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({
        verified_at: new Date(),
        verification_token_hash: null,
        verification_expires_at: null,
        updated_at: new Date(),
      })
      .where('verification_token_hash', '=', sha256Hex(token))
      .where('verification_expires_at', '>', new Date())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Unsubscribe tokens are `<subscriptionId>.<mac>` so links keep working without DB state. */
  unsubscribeToken(subscriptionId: string): string {
    return unsubscribeTokenFor(this.box, subscriptionId);
  }

  async unsubscribe(token: string): Promise<boolean> {
    const [id, mac] = token.split('.');
    if (!id || !mac || !z.uuid().safeParse(id).success) return false;
    if (!this.box.verifyMac('unsubscribe', id, mac)) return false;
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({ enabled: false, disabled_reason: 'unsubscribed via email link', updated_at: new Date() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  private async own(account: string, id: string): Promise<Subscription> {
    const row = await this.db
      .selectFrom('notification_subscriptions')
      .selectAll()
      .where('id', '=', id)
      .where('account', '=', account)
      .executeTakeFirst();
    if (!row) throw notFound('Subscription');
    return row;
  }

  async update(account: string, id: string, input: UpdateSubscriptionInput) {
    const sub = await this.own(account, id);
    if (sub.channel === 'email' && (input.url !== undefined || input.format !== undefined)) {
      throw badRequest(
        'url and format apply to webhook subscriptions only; recreate to change the email address',
      );
    }
    if (input.url !== undefined) assertWebhookUrl(input.url, this.urlPolicy);
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.format !== undefined ? { format: input.format } : {}),
        ...(input.eventTypes !== undefined ? { event_types: [...new Set(input.eventTypes)] } : {}),
        ...(input.enabled !== undefined
          ? {
              enabled: input.enabled,
              ...(input.enabled ? { consecutive_failures: 0, disabled_reason: null } : {}),
            }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDto(row);
  }

  async remove(account: string, id: string): Promise<void> {
    await this.own(account, id);
    await this.db.deleteFrom('notification_subscriptions').where('id', '=', id).execute();
  }

  async rotateSecret(account: string, id: string) {
    const sub = await this.own(account, id);
    if (sub.channel !== 'webhook') throw badRequest('Only webhook subscriptions have signing secrets');
    const secret = `whsec_${randomToken(32)}`;
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({ secret_encrypted: this.box.seal(secret), updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toDto(row), secret };
  }

  /** Queues a `ping` delivery that goes through the normal dispatcher (signing, retries, logs). */
  async sendTest(account: string, id: string) {
    const sub = await this.own(account, id);
    if (sub.channel === 'email' && !sub.verified_at) throw conflict('Verify the email address first');
    const deliveryId = randomUUID();
    await this.db
      .insertInto('notification_deliveries')
      .values({
        id: deliveryId,
        subscription_id: sub.id,
        outbox_id: null,
        event_type: 'ping',
        payload: JSON.stringify({
          type: 'ping',
          treasuryId: sub.contract_id,
          data: { subscriptionId: sub.id },
        }),
        created_at: new Date(),
      })
      .execute();
    return { deliveryId };
  }

  async deliveries(
    account: string,
    opts: {
      subscriptionId?: string | undefined;
      status?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const after = decodeCursor(opts.cursor, deliveriesCursor);
    let q = this.db
      .selectFrom('notification_deliveries as d')
      .innerJoin('notification_subscriptions as s', 's.id', 'd.subscription_id')
      .selectAll('d')
      .where('s.account', '=', account);
    if (opts.subscriptionId) q = q.where('d.subscription_id', '=', opts.subscriptionId);
    if (opts.status) q = q.where('d.status', '=', opts.status as 'pending');
    if (after) {
      const [at, id] = after;
      q = q.where((eb) =>
        eb.or([
          eb('d.created_at', '<', new Date(at)),
          eb.and([eb('d.created_at', '=', new Date(at)), eb('d.id', '<', id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(opts.limit + 1)
      .execute();
    const page = paginate(rows, opts.limit, (r) => [r.created_at.toISOString(), r.id]);
    return {
      items: page.items.map((d) => ({
        id: d.id,
        subscriptionId: d.subscription_id,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.status === 'pending' ? d.next_attempt_at.toISOString() : null,
        lastStatusCode: d.last_status_code,
        lastError: d.last_error,
        createdAt: d.created_at.toISOString(),
        deliveredAt: d.delivered_at?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }
}

function toDto(s: Subscription) {
  return {
    id: s.id,
    channel: s.channel,
    format: s.format,
    url: s.url,
    email: s.email,
    verified: s.channel === 'webhook' || s.verified_at !== null,
    treasuryId: s.contract_id,
    eventTypes: s.event_types,
    enabled: s.enabled,
    consecutiveFailures: s.consecutive_failures,
    disabledReason: s.disabled_reason,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
  };
}
