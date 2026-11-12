import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM for OAuth tokens at rest. Key comes from TOKEN_ENCRYPTION_KEY (falls back to JWT_SECRET in dev). */
const key = () => createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || '').digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown token encoding');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Constant-time string compare (HMAC both sides so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const k = randomBytes(32);
  return timingSafeEqual(createHmac('sha256', k).update(a).digest(), createHmac('sha256', k).update(b).digest());
}

export const hmacHex = (secret: string, body: Buffer | string) => createHmac('sha256', secret).update(body).digest('hex');
