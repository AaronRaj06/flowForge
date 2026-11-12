export type TokenSet = { accessToken: string; refreshToken?: string | null; expiresAt?: Date | null };

export type ProviderAuth = {
  id: 'gmail' | 'slack' | 'sheets';
  label: string;
  configured: () => boolean;
  authorizeUrl: (state: string, redirectUri: string) => string;
  exchangeCode: (code: string, redirectUri: string) => Promise<TokenSet>;
  /** Absent when the provider's tokens never expire. */
  refresh?: (refreshToken: string) => Promise<TokenSet>;
};

export class ProviderAuthError extends Error {}
