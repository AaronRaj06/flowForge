import { create } from 'zustand';

type User = { id: string; email: string };

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {
    /* storage blocked: session-only auth */
  }
};

export const useAuth = create<{
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  signOut: () => void;
}>((set) => ({
  token: read('ff_token'),
  user: JSON.parse(read('ff_user') ?? 'null'),
  setSession: (token, user) => {
    write('ff_token', token);
    write('ff_user', JSON.stringify(user));
    set({ token, user });
  },
  signOut: () => {
    write('ff_token', null);
    write('ff_user', null);
    set({ token: null, user: null });
  },
}));

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { token, signOut } = useAuth.getState();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.status === 401 && token) signOut();
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body);
  return body as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
