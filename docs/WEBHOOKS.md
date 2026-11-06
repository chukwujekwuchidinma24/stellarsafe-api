# Notifications

Two channels: **webhooks** (below) and **email** (at the end).

## Subscribing

```http
POST /notifications/preferences
Authorization: Bearer <access token>

{ "url": "https://example.com/hooks/stellarsafe",
  "treasuryId": "C...",               // optional: omit for all treasuries you're a member of
  "eventTypes": ["proposal.created"], // optional: empty = all
  "format": "json" }                  // json | slack | discord
```

The response contains `secret` (`whsec_…`). **It is only shown here and on rotate.** Store it securely.

Event types: `treasury.initialized`, `member.added`, `member.removed`, `policy.updated`,
`recipient.added`, `recipient.removed`, `proposal.created`, `proposal.approved`,
`proposal.approval_revoked`, `proposal.executed`, `proposal.cancelled`, `proposal.expiring`. The test
endpoint sends `ping`.

### `proposal.expiring`

Unlike the others, this event comes from the worker, not the chain. Every
`PROPOSAL_EXPIRY_REMINDER_INTERVAL_MS` (default 5 min) the worker looks for pending proposals that
expire within `PROPOSAL_EXPIRY_REMINDER_HOURS` (default 24, `0` turns reminders off). It sends **one
reminder per proposal**, even across restarts, several workers and reprojection. Executed,
cancelled and already-expired proposals are skipped. A proposal created with less time left than
the window gets its reminder on the next run.

There is no `eventId`, `ledger` or `txHash`, and `occurredAt` is when the reminder was queued:

```json
{
  "type": "proposal.expiring",
  "treasuryId": "C…",
  "occurredAt": "2026-11-06T12:00:00.000Z",
  "data": {
    "id": "7",
    "proposer": "G…",
    "recipient": "G…",
    "token": "C…",
    "amount": "5000000000",
    "approvals": 1,
    "required_approvals": 2,
    "expires_at": "2026-11-07T09:30:00Z"
  }
}
```

Slack, Discord and email show it as `Proposal #7 in treasury CABC…WXYZ expires at
2026-11-07T09:30:00Z (1/2 approvals): 5000000000 of CTOK…EN12 to GREC…IPNT`.

## Request

```http
POST /hooks/stellarsafe
Content-Type: application/json
User-Agent: StellarSafe-Webhooks/1.0
X-StellarSafe-Event: proposal.created
X-StellarSafe-Delivery: 6f1c…            # stays the same across retries: use it to de-duplicate
X-StellarSafe-Signature: t=1767225600,v1=5d41402abc4b2a76b9719d911017c592…

{ "id": "6f1c…", "type": "proposal.created", "createdAt": "…",
  "payload": { "type": "proposal.created", "treasuryId": "C…", "eventId": "…", "ledger": 123,
               "txHash": "…", "occurredAt": "…", "data": { "id": "7", "amount": "5000000000", … } } }
```

## Verifying signatures

Compute `HMAC-SHA256(secret, "<t>.<raw body>")` and compare it, in constant time, with `v1`.
Also reject timestamps older than about 5 minutes to block replays.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody: string, header: string, secret: string, toleranceSec = 300): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const [, t, v1] = m;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
```

## Delivery semantics

- **At least once.** Any 2xx counts as success. Redirects are not followed.
- **Retries** happen on network errors, timeouts (`NOTIFY_TIMEOUT_MS`) and non-2xx responses. Delays
  grow exponentially with ±20% jitter (10 s, 40 s, 160 s, ~11 min, …, capped at 6 h). A larger
  `Retry-After` is honoured. After `NOTIFY_MAX_ATTEMPTS` the delivery is marked `dead`.
- **`410 Gone`** disables the subscription immediately. `NOTIFY_DISABLE_AFTER_FAILURES` dead
  deliveries in a row also disable it. Re-enable with `PATCH { "enabled": true }`.
- **History.** `GET /notifications/deliveries` shows status, attempts and the last error.

## Email

```http
POST /notifications/preferences
{ "channel": "email", "email": "treasurer@example.com", "treasuryId": "C…", "eventTypes": [] }
```

Requires `SMTP_URL`. Email uses **double opt-in**:

1. Creating the subscription sends a confirmation link (valid for 24 h). Nothing else is sent
   until the link is confirmed. `POST /notifications/preferences/:id/resend-verification` sends a
   new link and invalidates the old one.
2. The link opens a page with a **Confirm** button. Confirmation only happens on POST, because
   mail security scanners prefetch links and would otherwise confirm sign-ups by themselves.
3. Each address gets at most 3 confirmation emails per day, no matter how many accounts ask.
   This stops throwaway accounts from flooding someone's inbox.

Every notification email includes `List-Unsubscribe` and `List-Unsubscribe-Post` headers
(RFC 8058 one-click), plus an unsubscribe link. Unsubscribing disables the subscription.
Delivery failures retry with the same backoff as webhooks.
