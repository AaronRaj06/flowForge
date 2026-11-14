import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Button, Input, Label, Select } from '../components/ui';
import { useIntegrations } from '../hooks/useIntegrations';

type Credential = { id: string; name: string; type: string; createdAt: string };
type Types = Record<string, { label: string; secret: string }>;

/** One place for the keys key-based blocks use (OAuth apps are listed too, for completeness). */
export function Credentials() {
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [types, setTypes] = useState<Types>({});
  const [form, setForm] = useState({ name: '', type: 'discord', secret: '' });
  const [saving, setSaving] = useState(false);
  const { status, connect } = useIntegrations();

  const load = () => api<{ credentials: Credential[]; types: Types }>('/api/credentials').then((r) => (setCreds(r.credentials), setTypes(r.types))).catch(() => setCreds([]));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/api/credentials', { method: 'POST', json: form });
      toast.success(`Saved “${form.name}”`);
      setForm({ ...form, name: '', secret: '' });
      load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (c: Credential) => {
    await api(`/api/credentials/${c.id}`, { method: 'DELETE' }).catch((err) => toast.error(errorMessage(err)));
    load();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-[20px] font-semibold">Credentials</h1>
      <p className="mt-1 mb-6 text-[13px] text-muted">API keys and tokens for Discord, Telegram, Notion, GitHub and Airtable blocks. They’re encrypted at rest and never shown again after you save them.</p>

      <form onSubmit={add} className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[1fr_10rem]">
        <div>
          <Label htmlFor="cred-name">Name</Label>
          <Input id="cred-name" value={form.name} placeholder="Team Discord" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="cred-type">Service</Label>
          <Select id="cred-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {Object.entries(types).map(([k, t]) => (
              <option key={k} value={k}>{t.label}</option>
            ))}
          </Select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="cred-secret">{types[form.type]?.secret ?? 'Secret'}</Label>
          <Input id="cred-secret" type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="font-mono text-[12px]" />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={saving} disabled={!form.name.trim() || !form.secret.trim()}>
            Save credential
          </Button>
        </div>
      </form>

      <h2 className="mt-8 mb-2 text-[13px] font-medium text-muted">Saved</h2>
      {creds === null ? (
        <p className="text-[13px] text-faint">Loading…</p>
      ) : creds.length === 0 ? (
        <p className="text-[13px] text-faint">No credentials yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {creds.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <KeyRound size={15} className="text-muted" />
              <span className="flex-1 truncate text-[13px]">{c.name}</span>
              <span className="text-[12px] text-faint">{types[c.type]?.label ?? c.type}</span>
              <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 mb-2 text-[13px] font-medium text-muted">Connected apps (OAuth)</h2>
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {(['gmail', 'sheets', 'slack'] as const).map((p) => {
          const s = status(p);
          return (
            <li key={p} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="flex-1 capitalize">{p === 'sheets' ? 'Google Sheets' : p}</span>
              {s && !s.configured ? <span className="text-[12px] text-faint">Not set up on this server</span> : s?.connected ? <span className="text-[12px] text-st-success">Connected</span> : <Button size="sm" onClick={() => connect(p)}>Connect</Button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
