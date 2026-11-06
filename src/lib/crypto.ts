import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  return key;
}

function macWith(key: Buffer, purpose: string, data: string): string {
  const subkey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `stellarsafe:${purpose}`, 32));
  return createHmac('sha256', subkey).update(data).digest('base64url');
}

/**
 * AES-256-GCM envelope: base64url(iv).base64url(tag).base64url(ciphertext)
 *
 * Seals with the current key. Opens with the current key, then the previous one (if set),
 * so `SECRETS_ENCRYPTION_KEY` can be rotated without downtime. See docs/OPERATIONS.md.
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly previousKey: Buffer | undefined;

  constructor(base64Key: string, previousBase64Key?: string) {
    this.key = decodeKey(base64Key);
    this.previousKey = previousBase64Key ? decodeKey(previousBase64Key) : undefined;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }

  /** Purpose-bound MAC (HKDF-derived subkey), e.g. for unsubscribe links. Always uses the current key. */
  mac(purpose: string, data: string): string {
    return macWith(this.key, purpose, data);
  }

  /** Checks a MAC against the current key, then the previous one, so old links keep working during rotation. */
  verifyMac(purpose: string, data: string, mac: string): boolean {
    if (safeEqual(mac, macWith(this.key, purpose, data))) return true;
    return this.previousKey !== undefined && safeEqual(mac, macWith(this.previousKey, purpose, data));
  }

  open(sealed: string): string {
    return this.openWithKeyInfo(sealed).plaintext;
  }

  /**
   * Returns the value sealed with the current key, or null if it already is.
   * Throws if neither key can open it.
   */
  reseal(sealed: string): string | null {
    const { plaintext, usedPrevious } = this.openWithKeyInfo(sealed);
    return usedPrevious ? this.seal(plaintext) : null;
  }

  private openWithKeyInfo(sealed: string): { plaintext: string; usedPrevious: boolean } {
    const parts = sealed.split('.');
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (parts.length !== 3 || !iv || !tag || !ct) throw new Error('Malformed sealed secret');
    try {
      return { plaintext: decrypt(this.key, iv, tag, ct), usedPrevious: false };
    } catch (err) {
      if (!this.previousKey) throw err;
      return { plaintext: decrypt(this.previousKey, iv, tag, ct), usedPrevious: true };
    }
  }
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
