const KEY = 'fleetwake.session';

/**
 * Where the backend lives. Empty means same origin (local dev through the Vite proxy, or the
 * single-process production server). When the dashboard is hosted separately (Vercel) and the
 * backend elsewhere (Render), set VITE_API_URL at build time, e.g. https://fleetwake.onrender.com
 */
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s?.token) return null;
    const { exp } = JSON.parse(atob(s.token.split('.')[1]));
    return exp * 1000 > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: session lasts for this tab only */ }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, token } = {}) {
  const t = token ?? loadSession()?.token;
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json.error || `Request failed (${res.status})`);
  return json;
}
