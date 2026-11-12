import type { ProviderAuth, TokenSet } from './types.ts';
import { ProviderAuthError } from './types.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const body: any = await res.json().catch(() => ({}));
  // invalid_grant = refresh token revoked or expired: the user has to reconnect.
  if (!res.ok) throw new ProviderAuthError(body.error_description || body.error || `Google token request failed (${res.status})`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

/** Gmail and Sheets share Google's OAuth, but are connected separately so each asks only for its own scope. */
export function googleProvider(id: 'gmail' | 'sheets', label: string, scope: string): ProviderAuth {
  return {
    id,
    label,
    configured: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    authorizeUrl: (state, redirectUri) =>
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        access_type: 'offline',
        prompt: 'consent', // always return a refresh token
        include_granted_scopes: 'true',
        state,
      }),
    exchangeCode: (code, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

/** Google returns 401 for a revoked or expired access token. */
export async function googleFetch(url: string, accessToken: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } });
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ProviderAuthError(body.error?.message || 'Google rejected the access token');
  if (!res.ok) throw new Error(body.error?.message || `Google API error ${res.status}`);
  return body;
}
