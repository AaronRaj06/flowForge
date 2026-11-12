import { useCallback, useEffect, useState } from 'react';
import { api, useAuth } from '../lib/api';

export type IntegrationStatus = { provider: string; connected: boolean; configured: boolean; expiresAt: string | null };

/** Which OAuth providers the user has connected, plus a popup-based connect flow. */
export function useIntegrations() {
  const [items, setItems] = useState<IntegrationStatus[]>([]);
  const refresh = useCallback(() => api<{ integrations: IntegrationStatus[] }>('/api/integrations').then((r) => setItems(r.integrations)).catch(() => {}), []);

  useEffect(() => {
    refresh();
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === 'flowforge:oauth') refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  const connect = (provider: string) => {
    const token = useAuth.getState().token;
    window.open(`/api/integrations/${provider}/connect?token=${encodeURIComponent(token ?? '')}`, 'flowforge-oauth', 'width=520,height=680');
  };

  return { items, connect, refresh, status: (p: string) => items.find((i) => i.provider === p) };
}
