import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, loadSession, saveSession, setUnauthorizedHandler } from './api.js';
import { live } from './live.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(loadSession);
  const [meta, setMeta] = useState(null); // { fleets, zones, defaultLimitKmh, rules }

  const signOut = useCallback(() => {
    saveSession(null);
    live.disconnect();
    setSession(null);
    setMeta(null);
  }, []);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  useEffect(() => {
    if (!session) return;
    live.connect(session.token);
    let cancelled = false;
    api('/fleets').then((m) => {
      if (cancelled) return;
      setMeta(m);
      if (!live.fleets.length) live.subscribe(m.fleets.map((f) => f.id));
    }).catch(() => {});
    api('/incidents').then((r) => !cancelled && live.upsertIncidents(r.incidents)).catch(() => {});
    api('/incidents?status=resolved&limit=50').then((r) => !cancelled && live.upsertIncidents(r.incidents)).catch(() => {});
    return () => { cancelled = true; };
  }, [session]);

  const signIn = useCallback(async (username, password) => {
    const s = await api('/auth/login', { method: 'POST', body: { username, password } });
    saveSession(s);
    setSession(s);
  }, []);

  const value = useMemo(() => ({ session, meta, signIn, signOut }), [session, meta, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
