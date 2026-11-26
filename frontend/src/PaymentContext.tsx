import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { PaymentLedger } from './paymentLedger';

const Context = createContext<PaymentLedger | null>(null);
export function PaymentProvider({ children }: { children: ReactNode }) {
  const { api, session } = useAuth();
  const [ledger] = useState(() => new PaymentLedger(api, session!.business.id));
  return <Context.Provider value={ledger}>{children}</Context.Provider>;
}
export function usePayments() {
  const ledger = useContext(Context);
  if (!ledger) throw new Error('PaymentProvider is required');
  return ledger;
}
