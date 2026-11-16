export type Session = { workspace: { id: string; name: string; is_guest: boolean }; user: null | { id: string; email: string; name: string }; csrf: string; limits?: Record<string, number>; recoveryCode?: string };
let csrf = '';
export function setCsrf(value: string) { csrf = value || ''; }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  if (!response.ok) {
    let body: any;
    try { body = await response.json(); } catch { body = {}; }
    throw new Error(body.error || body.message || (response.status === 429 ? 'A usage limit was reached. Please try again shortly.' : `Request failed (${response.status}). Please try again.`));
  }
  if (response.status === 204) return null as T;
  return response.json();
}
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
export const date = (value?: string) => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
export const duration = (seconds: number = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const textArray = (value: any): string[] => Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : v.text || v.question || v.title || v.name || JSON.stringify(v)) : [];
