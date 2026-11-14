const KEY = 'fleetwake.session';

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
  const res = await fetch(`/api${path}`, {
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
