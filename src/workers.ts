import { StellarChainClient, type ChainClient } from './chain/chain-client.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { Indexer } from './indexer/indexer.js';
import { SecretBox } from './lib/crypto.js';
import type { Logger } from './lib/logger.js';
import { NotificationDispatcher } from './modules/notifications/dispatcher.js';
import { createSmtpMailer, type Mailer } from './modules/notifications/mailer.js';
import { sendWebhook, type WebhookSender } from './modules/notifications/sender.js';

export function createChainClient(config: Config): ChainClient {
  return new StellarChainClient({
    rpcUrl: config.STELLAR_RPC_URL,
    networkPassphrase: config.networkPassphrase,
    pageLimit: config.INDEXER_PAGE_LIMIT,
  });
}

/** Deletes expired auth artefacts and old notification history. */
export async function runMaintenance(db: DB, now = new Date()): Promise<void> {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  await db.deleteFrom('auth_challenges').where('expires_at', '<', daysAgo(1)).execute();
  await db.deleteFrom('refresh_tokens').where('expires_at', '<', daysAgo(7)).execute();
  await db.deleteFrom('notification_outbox').where('fanned_out_at', '<', daysAgo(30)).execute();
  await db
    .deleteFrom('notification_deliveries')
    .where('outbox_id', 'is', null)
    .where('created_at', '<', daysAgo(30))
    .execute();
}

export interface Workers {
  indexer: Indexer;
  dispatcher: NotificationDispatcher;
  start(): void;
  stop(): Promise<void>;
}

export function createWorkers(
  config: Config,
  db: DB,
  chain: ChainClient,
  log: Logger,
  sender: WebhookSender = sendWebhook,
  mailer: Mailer | undefined = config.SMTP_URL
    ? createSmtpMailer(config.SMTP_URL, config.EMAIL_FROM, config.NOTIFY_TIMEOUT_MS)
    : undefined,
): Workers {
  const indexer = new Indexer(db, chain, log.child({ component: 'indexer' }), {
    windowLedgers: config.INDEXER_WINDOW_LEDGERS,
    pollIntervalMs: config.INDEXER_POLL_INTERVAL_MS,
  });
  const dispatcher = new NotificationDispatcher(
    db,
    new SecretBox(config.SECRETS_ENCRYPTION_KEY, config.SECRETS_ENCRYPTION_KEY_PREVIOUS),
    sender,
    log.child({ component: 'notifications' }),
    {
      pollIntervalMs: config.NOTIFY_POLL_INTERVAL_MS,
      maxAttempts: config.NOTIFY_MAX_ATTEMPTS,
      timeoutMs: config.NOTIFY_TIMEOUT_MS,
      disableAfterFailures: config.NOTIFY_DISABLE_AFTER_FAILURES,
      allowPrivateTargets: config.NOTIFY_ALLOW_PRIVATE_TARGETS,
      mailer,
      publicUrl: config.PUBLIC_URL,
    },
  );
  let maintenance: NodeJS.Timeout | undefined;

  return {
    indexer,
    dispatcher,
    start() {
      indexer.start();
      dispatcher.start();
      const tick = () => runMaintenance(db).catch((err: unknown) => log.error({ err }, 'maintenance failed'));
      maintenance = setInterval(() => void tick(), 3600_000);
      maintenance.unref();
      void tick();
    },
    async stop() {
      if (maintenance) clearInterval(maintenance);
      await Promise.all([indexer.stop(), dispatcher.stop()]);
    },
  };
}
