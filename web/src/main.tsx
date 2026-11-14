import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { LogOut } from 'lucide-react';
import './index.css';
import { useAuth } from './lib/api';
import { Login, Logo } from './pages/Login';
import { Builder } from './pages/Builder';
import { Templates } from './pages/Templates';
import { Knowledge } from './pages/Knowledge';
import { UsagePage } from './pages/Usage';
import { Credentials } from './pages/Credentials';
import { Teams } from './pages/Teams';
import { cx } from './components/ui';

function Shell() {
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
        <span className="ml-auto truncate text-[12px] text-faint">{user?.email}</span>
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
      <App />
      <Toaster position="bottom-center" toastOptions={{ style: { fontFamily: 'var(--font-sans)', fontSize: 13 } }} />
    </BrowserRouter>
  </StrictMode>,
);
