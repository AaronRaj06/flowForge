import type { Context } from '../../engine/types.ts';
import { googleFetch } from '../google.ts';
import { withToken } from '../tokens.ts';

// Header values must be single-line, or a recipient could inject extra headers.
const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

export async function sendEmail(config: Record<string, any>, _context: Context, userId?: string) {
  const to = oneLine(config.to);
  if (!/^[^\s@,]+@[^\s@,]+(\s*,\s*[^\s@,]+@[^\s@,]+)*$/.test(to)) throw new Error(`Invalid recipient "${to}"`);
  const body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body, null, 2);
  const mime = [`To: ${to}`, `Subject: ${encodeHeader(oneLine(config.subject))}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(body ?? '').toString('base64')].join('\r\n');

  return withToken(userId, 'gmail', async (token) => {
    const res = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, {
      method: 'POST',
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
    });
    return { messageId: res.id, to };
  });
}
