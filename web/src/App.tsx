import { useState } from 'react';
import { Spinner } from './components/Spinner.js';
import { AppShell } from './components/AppShell.js';
import { useAuth } from './hooks/useAuth.js';
import { MeProvider } from './hooks/useMe.js';

function LoginPage({ onLogin }: { onLogin: (u: string, p: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onLogin(username, password);
    } catch {
      setError('Invalid username or password');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-accent mx-auto mb-4 flex items-center justify-center">
            <span className="text-white text-xl font-bold">TFV</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">TheFabricatorsVault</h1>
          <p className="text-xs text-gray-400 mt-1 tracking-wide italic">Light it up &bull; Stick it on &bull; Print it out</p>
          <p className="text-sm text-gray-500 mt-3">Sign in to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-surface-2 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {loading && <Spinner size="sm" />}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}

// Outer auth gate. Crucially, AppShell (and the routed views it hosts,
// VaultPage in particular) only mounts AFTER auth has been resolved —
// that's what prevents the data hooks (useAssets/useFolders/useProjects/
// useAssetStats) from firing while no JWT is present, getting 401'd,
// storing empty arrays, and then failing to refetch when login completes
// (user previously had to hit browser refresh to see their data after
// logging in). BrowserRouter wraps <App /> in main.tsx, one level up, so
// LoginPage/the checking-spinner state never has route-switch machinery
// they don't need.
export function App() {
  const { isAuthenticated, checking, authRequired, login, logout } = useAuth();

  if (checking) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (authRequired && !isAuthenticated) {
    return <LoginPage onLogin={login} />;
  }

  // MeProvider fetches GET /auth/me (Phase D, #2177) exactly once
  // per-session, right where isAuthenticated first flips true -- see
  // useMe.tsx for why this lives above AppShell rather than each
  // consumer (nav gating, Vault/convert route guards, ModelPage/
  // CollectionPage ownership checks) fetching its own copy.
  return (
    <MeProvider isAuthenticated={isAuthenticated}>
      <AppShell logout={logout} authRequired={authRequired} />
    </MeProvider>
  );
}
