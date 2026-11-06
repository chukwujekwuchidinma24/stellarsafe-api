# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - unreleased

### Added

- Wallet sign-in via SEP-53 messages and SEP-10 transactions, JWT access tokens, rotating refresh
  tokens with reuse detection.
- Treasury registry with on-chain existence and WASM-hash allowlist checks, plus live balances.
- Soroban event indexer with per-treasury checkpoints, windowed backfill, retention-gap detection,
  raw event log and reprojection CLI.
- Proposal API with computed status, approvals, `policyOutdated`, and content-addressed metadata
  committed on-chain.
- Audit trail of chain and API activity with filters, cursor pagination and CSV export.
- Webhook notifications (JSON, Slack, Discord) with HMAC signatures, SSRF protection, retries,
  dead-lettering, auto-disable and a delivery log.
- OpenAPI 3.1 docs, health and readiness probes, Prometheus metrics, Docker image, CI.
- Email notification channel with double opt-in, per-address send caps, scanner-safe
  confirmation pages and RFC 8058 one-click unsubscribe.
- Optional Redis-backed rate limiting shared across replicas (fails open, reported in readiness).
- Abuse limits: per-account registration cap, per-IP write limit, cached balance reads and probe.
- Indexes for the treasury list and pending-proposal counts (47× faster under load), plus a
  load-test harness (`bench/`).
- Zero-downtime rotation of `SECRETS_ENCRYPTION_KEY` via `SECRETS_ENCRYPTION_KEY_PREVIOUS` and the
  `rotate-secrets` CLI.
