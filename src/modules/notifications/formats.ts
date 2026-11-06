export type WebhookFormat = 'json' | 'slack' | 'discord';

interface OutboxPayload {
  type: string;
  treasuryId: string;
  txHash?: string;
  ledger?: number;
  occurredAt?: string;
  data?: Record<string, unknown>;
}

const short = (s: unknown) =>
  typeof s === 'string' && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : String(s);

/** One-line human summary used for chat integrations. */
export function summarize(p: OutboxPayload): string {
  const d = p.data ?? {};
  const t = short(p.treasuryId);
  switch (p.type) {
    case 'proposal.created':
      return `New payment proposal #${String(d.id)} in treasury ${t}: ${String(d.amount)} of ${short(d.token)} to ${short(d.recipient)} (needs ${String(d.required_approvals)} approvals)`;
    case 'proposal.approved':
      return `Proposal #${String(d.id)} in treasury ${t} approved by ${short(d.approver)} (${String(d.approvals)} approvals)`;
    case 'proposal.approval_revoked':
      return `Approval on proposal #${String(d.id)} in treasury ${t} revoked by ${short(d.approver)}`;
    case 'proposal.executed':
      return `Proposal #${String(d.id)} in treasury ${t} executed by ${short(d.executor)}`;
    case 'proposal.cancelled':
      return `Proposal #${String(d.id)} in treasury ${t} cancelled by ${short(d.by)}`;
    case 'proposal.expiring':
      return `Proposal #${String(d.id)} in treasury ${t} expires at ${String(d.expires_at)} (${String(d.approvals)}/${String(d.required_approvals)} approvals): ${String(d.amount)} of ${short(d.token)} to ${short(d.recipient)}`;
    case 'member.added':
      return `${short(d.member)} was added to treasury ${t}`;
    case 'member.removed':
      return `${short(d.member)} was removed from treasury ${t}`;
    case 'policy.updated':
      return `Spending policy of treasury ${t} updated`;
    case 'ping':
      return 'StellarSafe test notification';
    default:
      return `${p.type} in treasury ${t}`;
  }
}

export function renderBody(
  format: WebhookFormat,
  deliveryId: string,
  eventType: string,
  payload: unknown,
): string {
  const p = payload as OutboxPayload;
  switch (format) {
    case 'slack':
      return JSON.stringify({ text: `[StellarSafe] ${summarize(p)}` });
    case 'discord':
      return JSON.stringify({ content: `[StellarSafe] ${summarize(p)}`, allowed_mentions: { parse: [] } });
    case 'json':
      return JSON.stringify({
        id: deliveryId,
        type: eventType,
        createdAt: new Date().toISOString(),
        payload,
      });
  }
}

export interface EmailLinks {
  publicUrl: string;
  unsubscribeToken: string;
}

/** Plain-text notification email with RFC 8058 one-click unsubscribe headers. */
export function renderEmail(eventType: string, payload: unknown, links: EmailLinks) {
  const p = payload as OutboxPayload;
  const unsubscribeUrl = `${links.publicUrl}/notifications/email/unsubscribe?token=${encodeURIComponent(links.unsubscribeToken)}`;
  const lines = [
    summarize(p),
    '',
    `Treasury: ${p.treasuryId}`,
    ...(p.txHash ? [`Transaction: ${p.txHash}`] : []),
    ...(p.ledger ? [`Ledger: ${p.ledger}`] : []),
    '',
    'Always verify proposal details on-chain before signing. StellarSafe will never ask for your secret key.',
    '',
    `Unsubscribe: ${unsubscribeUrl}`,
  ];
  return {
    subject: `[StellarSafe] ${summarize(p)}`.slice(0, 200),
    text: lines.join('\n'),
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-StellarSafe-Event': eventType,
    },
  };
}

export function renderVerificationEmail(publicUrl: string, token: string) {
  const url = `${publicUrl}/notifications/email/verify?token=${encodeURIComponent(token)}`;
  return {
    subject: '[StellarSafe] Confirm your notification email',
    text: [
      'Someone (hopefully you) asked to receive StellarSafe treasury notifications at this address.',
      '',
      `Confirm: ${url}`,
      '',
      'The link expires in 24 hours. If you did not request this, ignore this email and nothing will be sent.',
    ].join('\n'),
  };
}
