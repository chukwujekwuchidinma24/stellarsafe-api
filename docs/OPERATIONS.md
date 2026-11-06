# Operations

## Processes

The same image runs three roles:

| Role       | Command                    | Scaling                                                                                                 |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| API        | `node dist/server.js`      | Stateless, scale horizontally behind a load balancer                                                    |
| Worker     | `node dist/worker.js`      | One replica is enough. Extra replicas are safe (locks, compare-and-set, `SKIP LOCKED`) but add RPC load |
| Migrations | `node dist/cli/migrate.js` | Run once per deploy, before starting the new version                                                    |

For small deployments, `RUN_WORKERS=true` runs the worker inside the API process.

## Production checklist

- [ ] `NODE_ENV=production` (HTTPS-only webhooks, JSON logs)
- [ ] `JWT_SECRET`: `openssl rand -base64 48`, stored in a secret manager
- [ ] `SECRETS_ENCRYPTION_KEY`: `openssl rand -base64 32`. **Back it up.** Losing it makes webhook secrets unreadable, and subscribers will need new ones. To change it, see [Rotating `SECRETS_ENCRYPTION_KEY`](#runbooks) below.
- [ ] `SEP10_SIGNING_SECRET` (optional): a dedicated, **unfunded** key
- [ ] `PUBLIC_URL` and `AUTH_HOME_DOMAIN` set to the public API domain (these are embedded in sign-in messages)
- [ ] `CORS_ORIGINS` set to the web app's origin(s)
- [ ] `TRUST_PROXY=true` behind a load balancer, so rate limits apply to real client IPs
- [ ] `TRUSTED_WASM_HASHES` set to the audited contract build hash(es)
- [ ] `METRICS_TOKEN` set, or `/metrics` blocked at the edge
- [ ] `DATABASE_SSL=true` for managed Postgres
- [ ] `REDIS_URL` set if you run more than one API replica (shared rate limits)
- [ ] `SMTP_URL` and `EMAIL_FROM` set (from a domain with SPF/DKIM) to enable email notifications
- [ ] A dedicated or paid Soroban RPC endpoint (public endpoints are rate-limited)

## Probes and monitoring

- **Liveness:** `GET /health`. Only checks the process.
- **Readiness:** `GET /health/ready`. Returns `503` if the database is down. Returns `degraded`
  with HTTP 200 when RPC is unreachable or indexer lag exceeds `INDEXER_MAX_LAG_LEDGERS`, so a
  slow RPC doesn't take the API out of rotation.

Prometheus metrics (prefix `stellarsafe_`):

| Metric                                   | Alert suggestion                          |
| ---------------------------------------- | ----------------------------------------- |
| `indexer_lag_ledgers`                    | > 120 for 5 min (about 10 min behind)     |
| `indexer_errors_total`                   | rate > 0 for 10 min                       |
| `indexer_events_total{result="invalid"}` | any increase: a contract/decoder mismatch |
| `notification_deliveries_total{result}`  | dead/failure ratio                        |
| `http_request_duration_seconds`          | p95 latency, 5xx rate                     |

## Runbooks

**Indexer is lagging.** Check `indexer_errors_total` and the worker logs. Common causes are RPC
rate limiting (use a better RPC) or the window being too large (lower `INDEXER_WINDOW_LEDGERS`).
The indexer resumes from its checkpoints, so a restart is always safe.

**`historyComplete: false` on a treasury.** The treasury was registered, or the worker was down,
for longer than RPC retention (about 7 days on public nodes). Events from the gap are missing from
the read model. The contract state itself is unaffected. To recover, use an archival RPC: set
`last_indexed_ledger = <deploy ledger> - 1` and `history_complete = true`, then let the worker
backfill.

**Invalid events (`decode_error` set).** The contract emitted something the decoder rejects. Fix
the decoder (see [EVENTS.md](EVENTS.md)), deploy, then run
`DATABASE_URL=… node dist/cli/reproject.js <contractId>`, or `--all`. Reprojection runs in one
transaction and sends no notifications.

**Rotating `JWT_SECRET`.** Every access token becomes invalid immediately. Clients refresh
(refresh tokens are stored hashed and still work) or sign in again.

**Rotating `SECRETS_ENCRYPTION_KEY`.** This key encrypts webhook signing secrets and queued
email-verification tokens, and signs unsubscribe links. It can be rotated with no downtime and
no action from subscribers:

1. Generate a new key: `openssl rand -base64 32`. Back it up next to the old one.
2. Set `SECRETS_ENCRYPTION_KEY_PREVIOUS` to the **current** key and `SECRETS_ENCRYPTION_KEY` to
   the **new** key. Do this for the API and the worker.
3. Roll out the API and the worker. From now on new values are encrypted with the new key, and
   existing values decrypt with either key. Replicas still running the old config cannot read
   values written with the new key, so finish the rollout before the next step.
4. Re-encrypt everything stored with the old key, using the same environment:
   `npm run rotate-secrets` (or `node dist/cli/rotate-secrets.js` in the image). It is safe to
   run while the app is up and safe to re-run. It prints counts per table and exits non-zero if
   any value can't be decrypted with either key; in that case keep `_PREVIOUS` set and
   investigate the listed ids before going further.
5. Once it reports `0 unreadable`, remove `SECRETS_ENCRYPTION_KEY_PREVIOUS` and roll out again.
6. Destroy the old key, including from backups of your secrets store, once you no longer need
   to restore database backups taken before step 4.

Unsubscribe links in emails sent before the rotation keep working while
`SECRETS_ENCRYPTION_KEY_PREVIOUS` is set and stop working after step 5. Recipients can still
unsubscribe from any newer email. Keep `_PREVIOUS` set for a few days if that matters to you.

If the old key is lost rather than rotated, stored secrets can't be recovered: subscribers must
call `rotate-secret` to get new ones.

## Data retention

The worker prunes once an hour:

- auth challenges more than 1 day past expiry
- refresh tokens more than 7 days past expiry
- outbox rows (and their deliveries) 30 days after fan-out
- test pings after 30 days

`chain_events` and `activity` are kept forever. They are the audit trail.

## Backups

Back up Postgres regularly. The read model can be rebuilt from `chain_events`. Off-chain data
can't be rebuilt from the chain: names, proposal metadata, subscriptions and API audit entries.
