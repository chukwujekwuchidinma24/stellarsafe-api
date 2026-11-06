import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { SecretBox, safeEqual, sha256Hex } from '../../src/lib/crypto.js';
import { decodeCursor, encodeCursor, paginate } from '../../src/lib/pagination.js';
import { csvCell } from '../../src/modules/activity/service.js';
import { backoffMs } from '../../src/modules/notifications/dispatcher.js';
import { renderBody, summarize } from '../../src/modules/notifications/formats.js';
import { signPayload } from '../../src/modules/notifications/sender.js';
import { canonicalMetadata, computeStatus, metadataHash } from '../../src/modules/proposals/service.js';
import { z } from 'zod';

const baseEnv = {
  DATABASE_URL: 'postgres://x/y',
  STELLAR_RPC_URL: 'https://rpc.example',
  JWT_SECRET: 'a'.repeat(32),
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('config', () => {
  it('loads defaults and derives the network passphrase', () => {
    const c = loadConfig(baseEnv);
    expect(c.STELLAR_NETWORK).toBe('testnet');
    expect(c.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(c.authHomeDomain).toBe('localhost:3000');
  });

  it('refuses mainnet unless explicitly allowed', () => {
    expect(() => loadConfig({ ...baseEnv, STELLAR_NETWORK: 'mainnet' })).toThrow(/ALLOW_MAINNET/);
    expect(
      loadConfig({ ...baseEnv, STELLAR_NETWORK: 'mainnet', ALLOW_MAINNET: 'true' }).networkPassphrase,
    ).toContain('Public Global');
  });

  it('rejects weak secrets and private webhook targets in production', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...baseEnv, SECRETS_ENCRYPTION_KEY: 'abc' })).toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect(() =>
      loadConfig({ ...baseEnv, NODE_ENV: 'production', NOTIFY_ALLOW_PRIVATE_TARGETS: 'true' }),
    ).toThrow(/NOTIFY_ALLOW_PRIVATE_TARGETS/);
  });

  it('validates SECRETS_ENCRYPTION_KEY_PREVIOUS', () => {
    const prev = Buffer.alloc(32, 9).toString('base64');
    expect(
      loadConfig({ ...baseEnv, SECRETS_ENCRYPTION_KEY_PREVIOUS: prev }).SECRETS_ENCRYPTION_KEY_PREVIOUS,
    ).toBe(prev);
    expect(
      loadConfig({ ...baseEnv, SECRETS_ENCRYPTION_KEY_PREVIOUS: '' }).SECRETS_ENCRYPTION_KEY_PREVIOUS,
    ).toBeUndefined();
    expect(() => loadConfig({ ...baseEnv, SECRETS_ENCRYPTION_KEY_PREVIOUS: 'abc' })).toThrow(
      /SECRETS_ENCRYPTION_KEY_PREVIOUS/,
    );
    expect(() =>
      loadConfig({ ...baseEnv, SECRETS_ENCRYPTION_KEY_PREVIOUS: baseEnv.SECRETS_ENCRYPTION_KEY }),
    ).toThrow(/must differ/);
  });

  it('parses CSV lists', () => {
    expect(loadConfig({ ...baseEnv, CORS_ORIGINS: 'https://a.com, https://b.com,' }).CORS_ORIGINS).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));

  it('round-trips and uses a fresh IV each time', () => {
    const a = box.seal('whsec_abc');
    expect(box.open(a)).toBe('whsec_abc');
    expect(box.seal('whsec_abc')).not.toBe(a);
  });

  it('detects tampering and wrong keys', () => {
    const sealed = box.seal('secret');
    const [iv, tag, ct] = sealed.split('.');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => box.open([iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed)).toThrow();
    expect(() => box.open('garbage')).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox('AAAA')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 1).toString('base64'), 'AAAA')).toThrow();
  });
});

describe('SecretBox key rotation', () => {
  const oldKey = Buffer.alloc(32, 1).toString('base64');
  const newKey = Buffer.alloc(32, 2).toString('base64');
  const wrongKey = Buffer.alloc(32, 3).toString('base64');
  const oldBox = new SecretBox(oldKey);
  const rotating = new SecretBox(newKey, oldKey);

  it('seals with the current key', () => {
    const sealed = rotating.seal('whsec_new');
    expect(new SecretBox(newKey).open(sealed)).toBe('whsec_new');
    expect(() => oldBox.open(sealed)).toThrow();
  });

  it('opens values sealed with either the current or the previous key', () => {
    expect(rotating.open(oldBox.seal('whsec_old'))).toBe('whsec_old');
    expect(rotating.open(rotating.seal('whsec_new'))).toBe('whsec_new');
  });

  it('rejects values sealed with an unknown key', () => {
    const sealed = new SecretBox(wrongKey).seal('whsec_x');
    expect(() => rotating.open(sealed)).toThrow();
    expect(() => rotating.reseal(sealed)).toThrow();
    expect(() => new SecretBox(newKey).open(oldBox.seal('whsec_old'))).toThrow();
  });

  it('reseals previous-key values and leaves current ones alone', () => {
    const resealed = rotating.reseal(oldBox.seal('whsec_old'));
    expect(resealed).not.toBeNull();
    expect(new SecretBox(newKey).open(resealed!)).toBe('whsec_old');
    expect(rotating.reseal(rotating.seal('whsec_new'))).toBeNull();
  });

  it('verifies MACs from either key but signs with the current one', () => {
    const oldMac = oldBox.mac('unsubscribe', 'id-1');
    expect(rotating.verifyMac('unsubscribe', 'id-1', oldMac)).toBe(true);
    expect(rotating.verifyMac('unsubscribe', 'id-1', rotating.mac('unsubscribe', 'id-1'))).toBe(true);
    expect(rotating.mac('unsubscribe', 'id-1')).not.toBe(oldMac);
    expect(rotating.verifyMac('unsubscribe', 'id-2', oldMac)).toBe(false);
    expect(new SecretBox(newKey).verifyMac('unsubscribe', 'id-1', oldMac)).toBe(false);
    expect(
      rotating.verifyMac('unsubscribe', 'id-1', new SecretBox(wrongKey).mac('unsubscribe', 'id-1')),
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('safeEqual compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('cursors round-trip and reject tampering', () => {
    const schema = z.tuple([z.string(), z.number()]);
    expect(decodeCursor(encodeCursor(['a', 1]), schema)).toEqual(['a', 1]);
    expect(decodeCursor(undefined, schema)).toBeUndefined();
    expect(() => decodeCursor('!!!', schema)).toThrow('Invalid cursor');
    expect(() => decodeCursor(encodeCursor(['a', 'b']), schema)).toThrow('Invalid cursor');
  });

  it('paginate splits off the extra row', () => {
    expect(paginate([1, 2, 3], 2, (n) => [n])).toEqual({ items: [1, 2], nextCursor: encodeCursor([2]) });
    expect(paginate([1], 2, (n) => [n])).toEqual({ items: [1], nextCursor: null });
  });

  it('csvCell quotes and neutralises formulas', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
  });

  it('backoff grows exponentially with bounded jitter and a cap', () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(10_000);
    expect(backoffMs(2, mid)).toBe(40_000);
    expect(backoffMs(20, mid)).toBe(6 * 3600_000);
    expect(backoffMs(1, () => 0)).toBe(8_000);
    expect(backoffMs(1, () => 1)).toBe(12_000);
  });

  it('webhook signatures are HMAC-SHA256 over "<t>.<body>"', () => {
    const expected = createHmac('sha256', 'whsec_x').update('1700000000.{}').digest('hex');
    expect(signPayload('whsec_x', '{}', 1700000000)).toBe(`t=1700000000,v1=${expected}`);
    expect(signPayload('whsec_x', '{}', 1)).toMatch(/^t=1,v1=[0-9a-f]{64}$/);
    expect(signPayload('whsec_x', '{}', 1)).not.toBe(signPayload('whsec_y', '{}', 1));
  });
});

describe('proposal metadata hashing', () => {
  it('is canonical: key order and absent fields do not matter', () => {
    const a = canonicalMetadata({ title: 'Payroll', description: 'March' });
    expect(a).toBe('{"description":"March","title":"Payroll"}');
    expect(
      canonicalMetadata({ externalUrl: 'https://x.io', category: 'ops', description: 'd', title: 't' }),
    ).toBe('{"category":"ops","description":"d","externalUrl":"https://x.io","title":"t"}');
    expect(metadataHash({ title: 'Payroll', description: 'March' })).toBe(sha256Hex(a));
  });

  it('computes expired status from expiry', () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 1000);
    expect(computeStatus({ status: 'pending', expires_at: past })).toBe('expired');
    expect(computeStatus({ status: 'pending', expires_at: future })).toBe('pending');
    expect(computeStatus({ status: 'executed', expires_at: past })).toBe('executed');
  });
});

describe('notification formats', () => {
  const payload = {
    type: 'proposal.created',
    treasuryId: 'CABCDEFGHIJKLMNOP',
    data: {
      id: '7',
      amount: '500',
      token: 'CTOKEN1234567890',
      recipient: 'GRECIPIENT123456',
      required_approvals: 2,
    },
  };

  it('summarises events for chat', () => {
    expect(summarize(payload)).toContain('New payment proposal #7');
    expect(summarize({ type: 'ping', treasuryId: 'C' })).toContain('test');
    expect(summarize({ type: 'something.else', treasuryId: 'C' })).toContain('something.else');
  });

  it('renders json, slack and discord bodies', () => {
    expect(JSON.parse(renderBody('json', 'd1', 'proposal.created', payload))).toMatchObject({
      id: 'd1',
      type: 'proposal.created',
      payload,
    });
    expect(JSON.parse(renderBody('slack', 'd1', 'proposal.created', payload)).text).toContain(
      '[StellarSafe]',
    );
    expect(JSON.parse(renderBody('discord', 'd1', 'proposal.created', payload))).toMatchObject({
      allowed_mentions: { parse: [] },
    });
  });
});
