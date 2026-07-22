import type { ReactNode } from 'react';
import { useMe } from '../hooks/useMe.js';
import { Spinner } from './Spinner.js';

// Clean, non-crash landing for a member who lands on an admin-only route
// (direct URL, stale bookmark, whatever) -- per the D4 ticket's "direct-
// URL access by members shows a clean not-authorized state, not a
// crash." Deliberately not a redirect: bouncing the user somewhere else
// without explanation reads as a bug ("why did clicking this link take
// me to Browse?"); saying plainly that the page is admin-only is more
// honest about what actually happened.
export function NotAuthorized() {
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <div className="text-center text-gray-500 dark:text-gray-400">
        <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Not authorized</p>
        <p className="text-sm mt-1">This page is only available to admins.</p>
      </div>
    </div>
  );
}

// Route guard for admin-only pages (Vault, the folder-convert wizard).
// This is a UX nicety, NOT the security boundary -- every API route
// these pages call is independently requireAdmin/requireAuth-gated
// server-side (api/src/auth.ts) regardless of what this component
// decides to render; a member who bypassed this client-side check
// entirely would still 401/403 on every actual mutation. Its only job is
// to keep a member from landing on a half-functional page (buttons that
// silently 403 on click) instead of one clean, honest message.
//
// Waits out `loading` before deciding -- useMe()'s /auth/me fetch is
// async, so rendering NotAuthorized immediately (before the identity
// resolves) would flash the wrong state at an admin on every page load.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useMe();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!isAdmin) return <NotAuthorized />;

  return <>{children}</>;
}
