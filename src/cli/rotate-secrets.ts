/**
 * Re-encrypts stored secrets (webhook signing secrets, queued email-verification tokens) with
 * SECRETS_ENCRYPTION_KEY. Run after deploying a new key with the old one in
 * SECRETS_ENCRYPTION_KEY_PREVIOUS. Safe to run while the app is up, and safe to re-run.
 *
 *   npm run rotate-secrets
 */
import { createDb } from '../db/index.js';
import { SecretBox } from '../lib/crypto.js';
import { rotateSecrets } from '../modules/notifications/rotate-secrets.js';

const url = process.env.DATABASE_URL;
const key = process.env.SECRETS_ENCRYPTION_KEY;
const previous = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS || undefined;
if (!url || !key) {
  console.error(
    'usage: DATABASE_URL=... SECRETS_ENCRYPTION_KEY=... [SECRETS_ENCRYPTION_KEY_PREVIOUS=...] rotate-secrets',
  );
  process.exit(1);
}
if (!previous)
  console.warn('SECRETS_ENCRYPTION_KEY_PREVIOUS is not set; only checking that everything opens.');

const box = new SecretBox(key, previous);
const db = createDb({ connectionString: url, max: 2, ssl: process.env.DATABASE_SSL === 'true' });
const result = await rotateSecrets(db, box);
await db.destroy();

let failed = 0;
for (const [name, s] of Object.entries(result)) {
  console.log(
    `${name}: ${s.rotated} re-encrypted, ${s.current} already current, ${s.skipped} changed concurrently, ${s.failed.length} unreadable`,
  );
  for (const id of s.failed) console.error(`  ✖ ${name} ${id}: neither key can decrypt it`);
  failed += s.failed.length;
}
if (failed > 0) {
  console.error(
    `${failed} value(s) could not be decrypted. Keep SECRETS_ENCRYPTION_KEY_PREVIOUS set and investigate.`,
  );
  process.exit(1);
}
if (previous) console.log('Done. You can now remove SECRETS_ENCRYPTION_KEY_PREVIOUS.');
