import { useState } from 'react';
import { api, errorMessage, useAuth } from '../lib/api';
import { Button, Input, Label } from '../components/ui';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setSession = useAuth((s) => s.setSession);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/api/auth/${mode}`, { method: 'POST', json: { email, password } });
      setSession(r.token, r.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2 text-[15px] font-semibold">
            <Logo /> Flowforge
          </div>
          <h1 className="text-[22px] leading-tight font-semibold">{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
          <p className="mt-1 text-[13px] text-muted">Wire LLM calls, HTTP requests and integrations into pipelines you can run, schedule or call as an API.</p>
        </div>
        <form onSubmit={submit} className="space-y-3.5">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="password" hint={mode === 'register' ? 'At least 8 characters.' : undefined}>
              Password
            </Label>
            <Input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-st-error">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} className="w-full">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
        <p className="mt-5 text-[13px] text-muted">
          {mode === 'login' ? 'New here? ' : 'Already have an account? '}
          <button className="font-medium text-accent hover:underline" onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), setError(null))}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <rect x="1" y="3" width="7" height="5" rx="1.5" fill="currentColor" />
      <rect x="12" y="12" width="7" height="5" rx="1.5" fill="currentColor" />
      <path d="M8 5.5h2.5a2 2 0 0 1 2 2v4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}
