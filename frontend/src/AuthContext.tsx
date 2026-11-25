import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiClient } from './api';
import type { BusinessProfile, Credentials, Registration, UserProfile } from './api';
import { checkIdentity, tokenExpiresAt } from './session';

type Session = { user: UserProfile; business: BusinessProfile; expiresAt: number; key: number };
type Auth = { session: Session | null; busy: boolean; message: string; api: ApiClient; login: (data: Credentials) => Promise<void>; register: (data: Registration) => Promise<void>; logout: () => void };
const Context = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const token = useRef<string | null>(null);
  const generation = useRef(0);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  function clear(reason: string) {
    generation.current++; token.current = null; setSession(null); setBusy(false); setMessage(reason);
    window.location.hash = 'login';
  }
  const [api] = useState(() => new ApiClient(import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000', {
    token: () => token.current,
    unauthorized: rejected => { if (token.current === rejected) clear('Your session has ended. Please log in again.'); },
  }));

  async function authenticate(data: Credentials, registration?: Registration) {
    if (busy) return;
    const attempt = ++generation.current;
    token.current = null; setSession(null); setBusy(true); setMessage('');
    let registered = false;
    try {
      if (registration) { await api.register(registration); registered = true; }
      if (generation.current !== attempt) return;
      const result = await api.login(data);
      if (generation.current !== attempt) return;
      const expiresAt = tokenExpiresAt(result.access_token);
      if (expiresAt <= Date.now()) throw new Error('Your session has expired. Please log in again.');
      token.current = result.access_token;
      const [user, business] = await Promise.all([api.me(), api.business()]);
      if (generation.current !== attempt) return;
      checkIdentity(user, business);
      if (expiresAt <= Date.now()) throw new Error('Your session has expired. Please log in again.');
      setSession({ user, business, expiresAt, key: attempt });
      window.location.hash = 'dashboard';
    } catch (error) {
      if (generation.current === attempt) {
        token.current = null; setSession(null);
        if (registered) {
          setMessage('Your account was created. Please log in to continue. ' + (error instanceof Error ? error.message : ''));
          window.location.hash = 'login';
        }
        throw error;
      }
    } finally { if (generation.current === attempt) setBusy(false); }
  }

  useEffect(() => {
    if (!session) return;
    const check = () => { if (Date.now() >= session.expiresAt) clear('Your session has expired. Please log in again.'); };
    const timer = window.setTimeout(check, Math.min(session.expiresAt - Date.now(), 2147483647));
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { clearTimeout(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [session]);

  return <Context.Provider value={{ session, busy, message, api, login: data => authenticate(data), register: data => authenticate(data, data), logout: () => clear('You have been logged out.') }}>{children}</Context.Provider>;
}

export function useAuth() {
  const auth = useContext(Context);
  if (!auth) throw new Error('AuthProvider is required');
  return auth;
}
