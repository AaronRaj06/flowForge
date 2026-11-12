import type { Context } from '../../engine/types.ts';
import { withToken } from '../tokens.ts';
import { ProviderAuthError } from '../types.ts';

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

export async function postMessage(config: Record<string, any>, _context: Context, userId?: string) {
  if (!config.channel) throw new Error('Slack node needs a channel');
  const text = typeof config.text === 'string' ? config.text : JSON.stringify(config.text);
  return withToken(userId, 'slack', async (token) => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: String(config.channel).replace(/^#/, ''), text }),
    });
    const body: any = await res.json();
    if (!body.ok) {
      if (AUTH_ERRORS.has(body.error)) throw new ProviderAuthError(body.error);
      throw new Error(`Slack: ${body.error}`);
    }
    return { channel: body.channel, ts: body.ts };
  });
}
