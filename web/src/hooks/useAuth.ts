import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('mv_token'));
  const [authRequired, setAuthRequired] = useState<boolean>(true);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.health().then((h) => {
      setAuthRequired(h.authRequired);
      if (!h.authRequired) setToken('no-auth');
    }).catch(() => {
      // API unreachable — still require auth check
    }).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const handler = () => {
      setToken(null);
      localStorage.removeItem('mv_token');
    };
    window.addEventListener('mv:unauthorized', handler);
    return () => window.removeEventListener('mv:unauthorized', handler);
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const res = await api.auth.login(username, password);
    localStorage.setItem('mv_token', res.token);
    setToken(res.token);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('mv_token');
    setToken(null);
  }, []);

  const isAuthenticated = !authRequired || !!token;

  return { token, isAuthenticated, authRequired, checking, login, logout };
}
