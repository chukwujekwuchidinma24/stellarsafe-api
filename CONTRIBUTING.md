# Contributing

Thanks for helping build StellarSafe. This repo is the backend. Contracts, web app and SDK live
in sibling repositories under `stellarsafe-labs`.

## Setup

```bash
npm ci
npm test          # needs Docker (Testcontainers starts Postgres), or set TEST_DATABASE_URL
npm run check     # what CI runs: typecheck, lint, format, tests
```

## Ground rules

1. **The chain is the authority.** Never add an endpoint that lets the API approve, execute or
   change on-chain state for a user, or that hides on-chain facts. Off-chain writes must check
   indexed membership.
2. **Tests come with changes.** Bug fixes need a regression test. Endpoints need integration tests
   (`test/integration`). Pure logic gets unit tests. Coverage thresholds are enforced in
   `vitest.config.ts`.
3. **Schema changes go through migrations.** Add `src/db/migrations/000N_name.ts`, register it in
   `src/db/migrator.ts`, and update `src/db/schema.ts`. Never edit a migration that has shipped.
4. **API changes update the spec.** Run `npm run openapi` and commit `openapi.json`.
5. **Event schema changes** need a matching PR in `stellarsafe-contracts` and an update to
   `docs/EVENTS.md`.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Layout

```
src/
  app.ts            Fastify app factory (plugins, routes)
  server.ts         API entrypoint          worker.ts   indexer + dispatcher entrypoint
  config.ts         env validation          workers.ts  worker wiring + maintenance
  chain/            RPC client (only place that talks to Stellar)
  indexer/          decoder, projector, indexer loop, reprojection
  modules/<name>/   routes.ts (HTTP + zod schemas) and service.ts (logic)
  db/               Kysely types, migrations
test/
  unit/             pure functions
  integration/      real Postgres + FakeChain + app.inject
  helpers/          EventFactory builds realistic Soroban events
```

## Good first issues

Each comes with clear acceptance criteria:

| Area          | Task                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Notifications | "Proposal expiring soon" reminders (scheduled job, de-duplicated per proposal)                  |
| API           | `GET /treasuries/:id/spending` showing per-department, per-period totals from `executed` events |
| Auth          | SEP-10 multisig thresholds (load account signers from Horizon)                                  |
| Indexer       | Admin endpoint/CLI to reset a treasury's checkpoint for an archival backfill                    |
| Ops           | OpenTelemetry tracing for HTTP, DB and RPC calls                                                |
| Tests         | Property-based tests for the decoder (fast-check) using random `ScVal` bodies                   |

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
