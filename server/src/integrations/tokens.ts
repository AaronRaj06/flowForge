import { prisma } from '../db.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { AuthError } from '../engine/errors.ts';
import { providers } from './registry.ts';
import { ProviderAuthError, type TokenSet } from './types.ts';

/** Refresh this long before expiry so a token can't die mid-request. */
const SKEW_MS = 60_000;

export async function saveToken(userId: string, provider: string, t: TokenSet, keepRefresh?: string | null) {
  const refresh = t.refreshToken ?? keepRefresh ?? null;
  const data = {
    accessToken: encrypt(t.accessToken),
    refreshToken: refresh ? encrypt(refresh) : null,
    expiresAt: t.expiresAt ?? null,
  };
  await prisma.integrationToken.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, ...data },
    update: data,
  });
}

/**
 * Returns a usable access token, refreshing it first if it has expired.
 * Every integration action calls this; a revoked or missing grant becomes an AuthError,
 * which the runner reports as `auth_error` so the UI can offer a reconnect.
 */
export async function getValidToken(userId: string | undefined, provider: string): Promise<string> {
  const label = providers[provider]?.label ?? provider;
  if (!userId) throw new AuthError(provider, `${label} needs a signed-in user`);
  const row = await prisma.integrationToken.findUnique({ where: { userId_provider: { userId, provider } } });
  if (!row) throw new AuthError(provider, `${label} is not connected`);

  const access = decrypt(row.accessToken);
  if (!row.expiresAt || row.expiresAt.getTime() - SKEW_MS > Date.now()) return access;

  const refresh = row.refreshToken ? decrypt(row.refreshToken) : null;
  const auth = providers[provider];
  if (!refresh || !auth?.refresh) throw new AuthError(provider, `${label} access expired. Reconnect to continue.`);
  try {
    const next = await auth.refresh(refresh);
    await saveToken(userId, provider, next, refresh);
    return next.accessToken;
  } catch (err) {
    if (err instanceof ProviderAuthError) throw new AuthError(provider, `${label} access was revoked. Reconnect to continue. (${err.message})`);
    throw err;
  }
}

/** Runs an integration call, turning provider auth failures into AuthError. */
export async function withToken<T>(userId: string | undefined, provider: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getValidToken(userId, provider);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      throw new AuthError(provider, `${providers[provider]?.label ?? provider} access was revoked. Reconnect to continue. (${err.message})`);
    }
    throw err;
  }
}
