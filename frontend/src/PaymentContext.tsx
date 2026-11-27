import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { PaymentLedger } from './paymentLedger';

const Context = createContext<PaymentLedger | null>(null);
export function PaymentProvider({ children }: { children: ReactNode }) {
  const { api, session, isSessionCurrent, logout } = useAuth();
  const [ledger] = useState(() => new PaymentLedger(api, session!.business.id, {
    user: session!.user.id, role: session!.user.role, storage: () => localStorage,
    locks: () => navigator.locks, active: () => isSessionCurrent(session!.key), forbidden: logout,
  }));
  useEffect(() => { const changed = (event: StorageEvent) => ledger.storageChanged(event.key); window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed); }, [ledger]);
  return <Context.Provider value={ledger}>{children}</Context.Provider>;
}
export function usePayments() {
  const ledger = useContext(Context);
  if (!ledger) throw new Error('PaymentProvider is required');
  return ledger;
}
