import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.js';
import type { AuthMeOut } from '../lib/api.js';

// Whole-app identity/role context (Phase D4, #2180, plan §6). Extends
// useAuth.ts (which only ever tracked the JWT itself, never who it
// belongs to) with the one thing #2177's GET /auth/me contract was built
// for: a single fetched-once-per-session copy of {id, username,
// displayName, role} that every client-side role gate (admin nav, Vault/
// convert route guards, ModelPage/CollectionPage ownership checks) reads
// from, instead of each consumer fetching (or worse, decoding the JWT
// for) its own copy -- UsersSection.tsx's #2178 self-lockout check is the
// one existing example of the "fetched locally" pattern this supersedes
// for every NEW consumer; UsersSection itself is left as-is (already
// shipped, already tested, and its one `currentUserId` field isn't worth
// the churn of migrating a working component just to point at this).
//
// Gating built on top of `isAdmin`/`me` here is a UX nicety, never the
// security boundary -- every route this feeds (RequireAdmin, ModelPage's/
// CollectionPage's isOwnerOrAdmin checks) is independently enforced
// server-side (requireAdmin / requireAuth + api/src/services/
// visibility.ts's isOwnerOrAdmin) regardless of what this context says.
export interface MeContextValue {
  me: AuthMeOut | null;
  loading: boolean;
  error: string | null;
  // Convenience derived flag -- `me?.role === 'admin'`, computed once
  // here so consumers don't each repeat the `me?.role === 'admin'`
  // optional-chain themselves.
  isAdmin: boolean;
  refresh: () => Promise<void>;
}

// Default context value used only when a consumer renders outside a
// MeProvider (some older tests render a single view/component directly,
// no App-level wrapper). Least-privilege by construction -- same as the
// real fetch-failure fallback below -- so a missing provider silently
// degrades to "member, not admin" rather than throwing. Real app usage
// always has a MeProvider (see App.tsx); this is a defensive default,
// not the intended integration path.
const LEAST_PRIVILEGE: MeContextValue = {
  me: null,
  loading: false,
  error: null,
  isAdmin: false,
  refresh: async () => {},
};

const MeContext = createContext<MeContextValue>(LEAST_PRIVILEGE);

interface MeProviderProps {
  // Mirrors useAuth()'s own `isAuthenticated` -- the provider only
  // fetches /auth/me once there's a session to ask about, and clears any
  // held identity immediately on logout (never lets a stale `me` from a
  // previous session leak into the next login).
  isAuthenticated: boolean;
  children: ReactNode;
}

export function MeProvider({ isAuthenticated, children }: MeProviderProps) {
  const [me, setMe] = useState<AuthMeOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.auth.me();
      setMe(result);
    } catch (err) {
      // Fetch failure (network hiccup, expired token racing a refresh,
      // whatever) is treated as least-privilege -- `me: null` -- exactly
      // the same shape every consumer already handles for "not logged in
      // yet" or "no provider". Never crashes the app over an identity
      // fetch that didn't land.
      setMe(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      refresh();
    } else {
      setMe(null);
      setError(null);
    }
  }, [isAuthenticated, refresh]);

  const value: MeContextValue = { me, loading, error, isAdmin: me?.role === 'admin', refresh };
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  return useContext(MeContext);
}
