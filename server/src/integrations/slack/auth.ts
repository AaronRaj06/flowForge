import type { ProviderAuth, TokenSet } from '../types.ts';
import { ProviderAuthError } from '../types.ts';

async function oauthAccess(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, ...params }),
  });
  const body: any = await res.json();
  if (!body.ok) throw new ProviderAuthError(`Slack: ${body.error}`);
  return {
    accessToken: body.access_token,
    // Only present when the Slack app has token rotation turned on.
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

export const slackAuth: ProviderAuth = {
  id: 'slack',
  label: 'Slack',
  configured: () => !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
  authorizeUrl: (state, redirectUri) =>
    'https://slack.com/oauth/v2/authorize?' +
    new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, scope: 'chat:write,chat:write.public', redirect_uri: redirectUri, state }),
  exchangeCode: (code, redirectUri) => oauthAccess({ code, redirect_uri: redirectUri }),
  refresh: (refreshToken) => oauthAccess({ grant_type: 'refresh_token', refresh_token: refreshToken }),
};
