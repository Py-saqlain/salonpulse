export type UserProfile = { id: string; business_id: string; full_name: string; email: string; role: 'owner' | 'staff'; is_active: boolean };
export type BusinessProfile = { id: string; name: string; timezone: string; currency: string; created_at: string; updated_at: string };
export type Credentials = { email: string; password: string };
export type Registration = Credentials & { business_name: string; full_name: string };
export type TokenResponse = { access_token: string; token_type: 'bearer' };
export type ValidationIssue = { loc: (string | number)[]; msg: string; type: string };

export class ApiError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;
  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message); this.name = 'ApiError'; this.status = status; this.fields = fields;
  }
}

export function apiBaseUrl(value = 'http://127.0.0.1:8000'): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

export class ApiClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly token: () => string | null;
  private readonly unauthorized: (token: string) => void;
  constructor(base: string, options: { fetcher?: typeof fetch; token?: () => string | null; unauthorized?: (token: string) => void } = {}) {
    this.base = apiBaseUrl(base); this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.token = options.token ?? (() => null); this.unauthorized = options.unauthorized ?? (() => {});
  }
  async request<T>(path: string, options: { method?: string; body?: unknown; public?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    // Only API-relative paths are accepted; never forward a Bearer token to another origin.
    if (!path.startsWith('/api/') || path.includes('..') || path.includes('\\') || path.includes('#')) throw new Error('Invalid API path');
    const token = options.public ? null : this.token();
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.base + path, {
          method: options.method ?? 'GET', headers, credentials: 'omit', cache: 'no-store',
          body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        throw new ApiError(0, controller.signal.aborted ? 'The request timed out or was cancelled. Please try again.' : 'Cannot reach SalonPulse. Check your connection and try again.');
      }
      if (response.status === 401 && token) this.unauthorized(token);
      if (response.status === 204) return undefined as T;
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new ApiError(response.status, 'The server returned an unreadable response. Please try again.'); }
      if (!response.ok) {
        const detail = (data as { detail?: unknown } | null)?.detail;
        const fields: Record<string, string> = {};
        if (Array.isArray(detail)) {
          for (const issue of detail as ValidationIssue[]) {
            const field = Array.isArray(issue.loc) ? issue.loc.filter(part => part !== 'body').join('.') : '';
            if (field && typeof issue.msg === 'string') fields[field] = issue.msg;
          }
        }
        const message = response.status >= 500 ? 'SalonPulse is temporarily unavailable. Please try again.'
          : response.status === 401 ? (token ? 'Your session has ended. Please log in again.' : 'Email or password is incorrect.')
          : typeof detail === 'string' ? detail : 'Please check the highlighted fields and try again.';
        throw new ApiError(response.status, message, fields);
      }
      return data as T;
    } finally {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
    }
  }
  login({ email, password }: Credentials) { return this.request<TokenResponse>('/api/auth/login', { method: 'POST', body: { email, password }, public: true }); }
  register({ email, password, full_name, business_name }: Registration) {
    return this.request<UserProfile>('/api/auth/register', { method: 'POST', body: { email, password, full_name, business_name }, public: true });
  }
  me() { return this.request<UserProfile>('/api/auth/me'); }
  business() { return this.request<BusinessProfile>('/api/business/me'); }
}
