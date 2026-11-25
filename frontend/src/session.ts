import type { BusinessProfile, UserProfile } from './api';
import type { DemoStore } from './data';

// Decoding only schedules local logout. The backend validates the token on every request.
export function tokenExpiresAt(token: string): number {
  try {
    const encoded = token.split('.')[1];
    const claims = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new Error();
    return claims.exp * 1000;
  } catch { throw new Error('The server returned an invalid session. Please log in again.'); }
}

export function checkIdentity(user: UserProfile, business: BusinessProfile): void {
  if (!user.is_active || !user.id || user.business_id !== business.id || !['owner', 'staff'].includes(user.role)) {
    throw new Error('Your business profile could not be verified. Please log in again.');
  }
}

export function emptyWorkspace(): DemoStore {
  // Never hydrate global demo storage, seed data or another login's workspace.
  return { customers: [], staff: [], services: [], appointments: [] };
}
