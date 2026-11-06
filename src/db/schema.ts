import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

/** timestamptz: read as Date, written as Date or ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
/** numeric / bigint columns are returned by node-postgres as strings to avoid precision loss. */
type Numeric = ColumnType<string, string | bigint | number, string | bigint | number>;
type Json = ColumnType<unknown, string, string>;

export interface AuthChallengesTable {
  id: string;
  account: string;
  mode: 'message' | 'transaction';
  payload: string;
  created_at: TimestampDefault;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}

export interface RefreshTokensTable {
  id: string;
  family_id: string;
  account: string;
  token_hash: string;
  created_at: TimestampDefault;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  user_agent: string | null;
  ip: string | null;
}

export interface TreasuriesTable {
  contract_id: string;
  network: string;
  name: string | null;
  description: string | null;
  status: 'pending' | 'active';
  wasm_hash: string | null;
  registered_by: string;
  start_ledger: number;
  last_indexed_ledger: number;
  history_complete: Generated<boolean>;
  initialized_ledger: number | null;
  initialized_at: Timestamp | null;
  admin: string | null;
  policy: Json | null;
  policy_version: number | null;
  threshold: number | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface TreasuryMembersTable {
  contract_id: string;
  account: string;
  role: string;
  added_ledger: number;
  added_at: Timestamp;
}

export interface TreasuryRecipientsTable {
  contract_id: string;
  address: string;
  label: string | null;
  added_ledger: number;
  added_at: Timestamp;
}

export interface ProposalsTable {
  contract_id: string;
  proposal_id: Numeric;
  proposer: string;
  recipient: string;
  token: string;
  amount: Numeric;
  department: string | null;
  metadata_hash: string | null;
  policy_version: number;
  required_approvals: number;
  approvals_count: Generated<number>;
  status: 'pending' | 'executed' | 'cancelled';
  expires_at: Timestamp;
  created_ledger: number;
  created_at: Timestamp;
  created_tx: string;
  executed_by: string | null;
  executed_at: Timestamp | null;
  executed_tx: string | null;
  cancelled_by: string | null;
  cancelled_at: Timestamp | null;
  cancelled_tx: string | null;
  updated_ledger: number;
}

export interface ProposalApprovalsTable {
  contract_id: string;
  proposal_id: Numeric;
  approver: string;
  ledger: number;
  tx_hash: string;
  approved_at: Timestamp;
}

export interface ProposalMetadataTable {
  contract_id: string;
  metadata_hash: string;
  title: string;
  description: string;
  category: string | null;
  external_url: string | null;
  created_by: string;
  created_at: TimestampDefault;
}

export interface ChainEventsTable {
  id: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: Timestamp;
  tx_hash: string;
  event_type: string | null;
  topic_xdr: string[];
  value_xdr: string;
  decode_error: string | null;
  ingested_at: TimestampDefault;
}

export interface ActivityTable {
  id: Generated<string>;
  contract_id: string;
  source: 'chain' | 'api';
  type: string;
  actor: string | null;
  proposal_id: Numeric | null;
  event_id: string | null;
  ledger: number | null;
  tx_hash: string | null;
  data: Json;
  occurred_at: Timestamp;
}

export interface NotificationSubscriptionsTable {
  id: string;
  account: string;
  contract_id: string | null;
  channel: 'webhook' | 'email';
  format: 'json' | 'slack' | 'discord';
  url: string | null;
  secret_encrypted: string | null;
  email: string | null;
  verified_at: Timestamp | null;
  verification_token_hash: string | null;
  verification_expires_at: Timestamp | null;
  event_types: string[];
  enabled: Generated<boolean>;
  consecutive_failures: Generated<number>;
  disabled_reason: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface NotificationOutboxTable {
  id: Generated<string>;
  contract_id: string;
  event_type: string;
  payload: Json;
  created_at: TimestampDefault;
  fanned_out_at: Timestamp | null;
}

export interface ProposalExpiryRemindersTable {
  contract_id: string;
  proposal_id: Numeric;
  expires_at: Timestamp;
  created_at: TimestampDefault;
}

export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'dead';

export interface NotificationDeliveriesTable {
  id: string;
  subscription_id: string;
  outbox_id: Numeric | null;
  event_type: string;
  payload: Json;
  status: Generated<DeliveryStatus>;
  attempts: Generated<number>;
  next_attempt_at: TimestampDefault;
  lease_expires_at: Timestamp | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: TimestampDefault;
  delivered_at: Timestamp | null;
}

export interface Database {
  auth_challenges: AuthChallengesTable;
  refresh_tokens: RefreshTokensTable;
  treasuries: TreasuriesTable;
  treasury_members: TreasuryMembersTable;
  treasury_recipients: TreasuryRecipientsTable;
  proposals: ProposalsTable;
  proposal_approvals: ProposalApprovalsTable;
  proposal_metadata: ProposalMetadataTable;
  chain_events: ChainEventsTable;
  activity: ActivityTable;
  notification_subscriptions: NotificationSubscriptionsTable;
  notification_outbox: NotificationOutboxTable;
  notification_deliveries: NotificationDeliveriesTable;
  proposal_expiry_reminders: ProposalExpiryRemindersTable;
}

export type Treasury = Selectable<TreasuriesTable>;
export type Proposal = Selectable<ProposalsTable>;
export type Subscription = Selectable<NotificationSubscriptionsTable>;
export type Delivery = Selectable<NotificationDeliveriesTable>;
export type NewActivity = Insertable<ActivityTable>;
