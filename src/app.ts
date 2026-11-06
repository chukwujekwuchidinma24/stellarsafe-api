import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ChainClient } from './chain/chain-client.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import { SecretBox } from './lib/crypto.js';
import { loggerOptions, type Logger } from './lib/logger.js';
import { httpRequestDuration } from './lib/metrics.js';
import { activityRoutes } from './modules/activity/routes.js';
import { ActivityService } from './modules/activity/service.js';
import { authRoutes } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { emailLinkRoutes } from './modules/notifications/email-routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { NotificationService } from './modules/notifications/service.js';
import { proposalRoutes } from './modules/proposals/routes.js';
import { ProposalService } from './modules/proposals/service.js';
import { treasuryRoutes } from './modules/treasuries/routes.js';
import { TreasuryService } from './modules/treasuries/service.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface AppDeps {
  config: Config;
  db: DB;
  chain: ChainClient;
  logger?: Logger;
  /** When set, rate limits are shared across all API replicas. */
  redis?: Redis;
}

export interface Services {
  auth: AuthService;
  treasuries: TreasuryService;
  proposals: ProposalService;
  activity: ActivityService;
  notifications: NotificationService;
}

export function createServices({ config, db, chain }: AppDeps): Services {
  const treasuries = new TreasuryService(db, chain, config);
  return {
    auth: new AuthService(db, config),
    treasuries,
    proposals: new ProposalService(db, treasuries),
    activity: new ActivityService(db),
    notifications: new NotificationService(
      db,
      treasuries,
      new SecretBox(config.SECRETS_ENCRYPTION_KEY, config.SECRETS_ENCRYPTION_KEY_PREVIOUS),
      config,
    ),
  };
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * zod emits an `<Name>Input` variant for every shared schema; drop components that nothing
 * references so SDK code generation only sees the types the API actually uses.
 */
function pruneUnusedSchemas<T>(doc: T): T {
  const d = doc as { components?: { schemas?: Record<string, unknown> } };
  const schemas = d.components?.schemas;
  if (!schemas) return doc;
  const refs = (value: unknown) =>
    [...JSON.stringify(value).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
  const used = new Set<string>();
  const queue = refs({ ...d, components: { ...d.components, schemas: {} } });
  while (queue.length) {
    const name = queue.pop()!;
    if (used.has(name)) continue;
    used.add(name);
    queue.push(...refs(schemas[name]));
  }
  d.components!.schemas = Object.fromEntries(Object.entries(schemas).filter(([k]) => used.has(k)));
  return doc;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, chain } = deps;
  const services = createServices(deps);

  const app = Fastify({
    ...(deps.logger
      ? { loggerInstance: deps.logger }
      : { logger: loggerOptions(config.LOG_LEVEL, !config.isProduction && config.NODE_ENV !== 'test') }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    httpRequestDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.includes('*') ? true : config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    ...(deps.redis
      ? {
          redis: deps.redis,
          nameSpace: 'stellarsafe:rl:',
          // Fail open: a Redis outage degrades rate limiting instead of taking the API down.
          skipOnError: true,
        }
      : {}),
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded, retry in ${ctx.after}`,
    }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'StellarSafe API',
        version: VERSION,
        description:
          'Off-chain coordination layer for StellarSafe treasuries: wallet sign-in, indexed treasury state, proposal ' +
          'metadata, audit trail and notifications.\n\n**The Soroban contracts are the source of truth.** This API ' +
          'never signs, approves or executes payments; indexed data can lag the chain and must not be treated as authority.',
        license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
      },
      servers: [{ url: config.PUBLIC_URL }],
      tags: [
        { name: 'auth', description: 'Wallet-signed sign-in (SEP-53 / SEP-10)' },
        { name: 'treasuries', description: 'Treasury registry, members and allowlists' },
        { name: 'proposals', description: 'Payment proposals and off-chain metadata' },
        { name: 'activity', description: 'Audit trail' },
        { name: 'notifications', description: 'Webhook subscriptions and delivery log' },
        { name: 'health', description: 'Probes' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: (doc) => pruneUnusedSchemas(jsonSchemaTransformObject(doc)),
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  await app.register(authPlugin, { auth: services.auth });
  await app.register(healthRoutes, { db, chain, config, version: VERSION, redis: deps.redis });
  await app.register(authRoutes, { prefix: '/auth', auth: services.auth, config });
  const writeLimit = config.RATE_LIMIT_WRITE_MAX;
  await app.register(treasuryRoutes, { prefix: '/treasuries', treasuries: services.treasuries, writeLimit });
  await app.register(proposalRoutes, { prefix: '/treasuries', proposals: services.proposals, writeLimit });
  await app.register(activityRoutes, {
    prefix: '/treasuries',
    activity: services.activity,
    treasuries: services.treasuries,
  });
  await app.register(notificationRoutes, { prefix: '/notifications', notifications: services.notifications });
  await app.register(emailLinkRoutes, {
    prefix: '/notifications/email',
    notifications: services.notifications,
  });

  return app;
}
