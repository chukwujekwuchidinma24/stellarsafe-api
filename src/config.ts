import { Networks } from '@stellar/stellar-sdk';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const NETWORK_PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
  local: Networks.STANDALONE,
} as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public base URL of this API, used for the auth challenge domain and OpenAPI servers. */
    PUBLIC_URL: z.url().default('http://localhost:3000'),
    TRUST_PROXY: bool.default(false),
    CORS_ORIGINS: csv.default([]),

    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_SSL: bool.default(false),

    STELLAR_NETWORK: z.enum(['testnet', 'mainnet', 'futurenet', 'local']).default('testnet'),
    STELLAR_RPC_URL: z.url(),
    STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
    /** Contracts are unaudited. Mainnet must be enabled explicitly. */
    ALLOW_MAINNET: bool.default(false),
    /** Optional allowlist of StellarSafe contract WASM hashes (hex). Empty = accept any contract. */
    TRUSTED_WASM_HASHES: csv.default([]),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('stellarsafe-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(90 * 86_400)
      .default(30 * 86_400),
    AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    /** Home domain shown in sign-in messages and SEP-10 challenges. Defaults to PUBLIC_URL host. */
    AUTH_HOME_DOMAIN: z.string().optional(),
    /** Server signing key for SEP-10 transaction challenges. When unset, only SEP-53 message sign-in is enabled. */
    SEP10_SIGNING_SECRET: z
      .string()
      .regex(/^S[A-Z2-7]{55}$/, 'must be a Stellar secret seed')
      .optional(),

    /** 32-byte key (base64) used to encrypt webhook secrets at rest. */
    SECRETS_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded'),
    /** Previous key, still accepted for decryption while rotating. Remove after `npm run rotate-secrets`. */
    SECRETS_ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded')
      .optional(),

    /** SMTP connection URL (smtp:// or smtps://). Enables the email notification channel. */
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    EMAIL_FROM: z.string().default('StellarSafe <notifications@stellarsafe.invalid>'),
    /** Shared rate-limit store for multi-replica deployments. Unset = per-process memory. */
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(20),
    /** Per-IP per-minute limit for costly writes (treasury registration; metadata gets 3x). */
    RATE_LIMIT_WRITE_MAX: z.coerce.number().int().min(1).default(10),
    METRICS_TOKEN: z.string().min(16).optional(),

    /** Run the indexer and notification dispatcher inside the API process. Prefer the separate worker in production. */
    RUN_WORKERS: bool.default(false),
    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** Ledgers scanned per getEvents window. RPC nodes cap ranges at 10,000. */
    INDEXER_WINDOW_LEDGERS: z.coerce.number().int().min(1).max(10_000).default(2_000),
    INDEXER_PAGE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(500),
    INDEXER_MAX_LAG_LEDGERS: z.coerce.number().int().min(1).default(120),

    NOTIFY_POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(2_000),
    NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
    NOTIFY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
    NOTIFY_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).default(20),
    /** Allow webhooks to private/loopback addresses. Never enable in production. */
    NOTIFY_ALLOW_PRIVATE_TARGETS: bool.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.STELLAR_NETWORK === 'mainnet' && !env.ALLOW_MAINNET) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_MAINNET'],
        message:
          'StellarSafe contracts are unaudited. Set ALLOW_MAINNET=true to run against mainnet deliberately.',
      });
    }
    if (
      env.SECRETS_ENCRYPTION_KEY_PREVIOUS !== undefined &&
      Buffer.from(env.SECRETS_ENCRYPTION_KEY_PREVIOUS, 'base64').equals(
        Buffer.from(env.SECRETS_ENCRYPTION_KEY, 'base64'),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SECRETS_ENCRYPTION_KEY_PREVIOUS'],
        message: 'must differ from SECRETS_ENCRYPTION_KEY',
      });
    }
    if (env.NODE_ENV === 'production' && env.NOTIFY_ALLOW_PRIVATE_TARGETS) {
      ctx.addIssue({
        code: 'custom',
        path: ['NOTIFY_ALLOW_PRIVATE_TARGETS'],
        message: 'must not be enabled in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface Config extends Env {
  networkPassphrase: string;
  authHomeDomain: string;
  isProduction: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset (common with docker-compose `VAR=` entries).
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const env = parsed.data;
  return {
    ...env,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? NETWORK_PASSPHRASES[env.STELLAR_NETWORK],
    authHomeDomain: env.AUTH_HOME_DOMAIN ?? new URL(env.PUBLIC_URL).host,
    isProduction: env.NODE_ENV === 'production',
  };
}
