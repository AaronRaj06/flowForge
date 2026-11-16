import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { LogOut } from 'lucide-react';
import './index.css';
import { api, errorMessage, useAuth } from './lib/api';
import { Login, Logo } from './pages/Login';
import { Builder } from './pages/Builder';
import { Templates } from './pages/Templates';
import { Knowledge } from './pages/Knowledge';
import { UsagePage } from './pages/Usage';
import { Credentials } from './pages/Credentials';
import { Teams } from './pages/Teams';
import { Button, Input, Label, Modal, cx } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';

function PasswordModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'POST', json: { current, password } });
      toast.success('Password changed');
      setCurrent('');
      setPassword('');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Change password">
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <Label htmlFor="pw-current">Current password</Label>
          <Input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pw-new" hint="At least 8 characters.">New password</Label>
          <Input id="pw-new" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>Change password</Button>
        </div>
      </form>
    </Modal>
  );
}

function Shell() {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('rounded-md px-2.5 py-1 text-[13px] font-medium', isActive ? 'bg-sunken text-ink' : 'text-muted hover:text-ink');
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        <span className="mr-3 flex items-center gap-2 text-[14px] font-semibold">
          <Logo /> Flowforge
        </span>
        <NavLink to="/" end className={({ isActive }) => link({ isActive: isActive || pathname.startsWith('/p/') })}>
          Builder
        </NavLink>
        <NavLink to="/templates" className={link}>Templates</NavLink>
        <NavLink to="/knowledge" className={link}>Knowledge</NavLink>
        <NavLink to="/teams" className={link}>Teams</NavLink>
        <NavLink to="/credentials" className={link}>Credentials</NavLink>
        <NavLink to="/usage" className={link}>Usage</NavLink>
        <button onClick={() => setPasswordOpen(true)} title="Change password" className="ml-auto truncate rounded-md px-1.5 py-1 text-[12px] text-faint hover:bg-sunken hover:text-ink">{user?.email}</button>
        <PasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
        <button onClick={signOut} className="press ml-2 rounded-md p-1.5 text-faint hover:bg-sunken hover:text-ink" aria-label="Sign out" title="Sign out">
          <LogOut size={15} />
        </button>
      </header>
      <Routes>
        <Route path="/" element={<Builder />} />
        <Route path="/p/:id" element={<Builder />} />
        <Route path="/templates" element={<div className="overflow-y-auto"><Templates /></div>} />
        <Route path="/knowledge" element={<div className="overflow-y-auto"><Knowledge /></div>} />
        <Route path="/teams" element={<div className="overflow-y-auto"><Teams /></div>} />
        <Route path="/credentials" element={<div className="overflow-y-auto"><Credentials /></div>} />
        <Route path="/usage" element={<div className="overflow-y-auto"><UsagePage /></div>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function App() {
  const token = useAuth((s) => s.token);
  return token ? <Shell /> : <Login />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <Toaster position="bottom-center" toastOptions={{ style: { fontFamily: 'var(--font-sans)', fontSize: 13 } }} />
    </BrowserRouter>
  </StrictMode>,
);
