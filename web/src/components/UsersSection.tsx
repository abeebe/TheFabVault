import { useState, useEffect } from 'react';
import {
  Plus, Copy, CheckCircle, AlertCircle, Loader,
  Shield, ShieldOff, KeyRound, UserX, UserCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useUsers } from '../hooks/useUsers.js';
import type { UserOut, UserRole } from '../lib/api.js';

// Users tab, AdminSettings (Phase D2, plan §6, #2178). Extracted into its
// own file rather than inlined in AdminSettings.tsx (already 800+ lines)
// -- same call DuplicatesModal.tsx/OrphansModal.tsx made for their
// sections: a self-contained feature with its own list/form/error state
// is easier to reason about (and test) as one file than folded into an
// already-large component. Unlike those two it isn't a separate modal --
// per the ticket this renders inline as a section, matching Network
// Mounts/Library Tools below it.

// routes/users.ts (server) returns `{ error: string }` JSON on every 4xx,
// but apiFetch (lib/api.ts) throws `Error(rawResponseText)` without
// parsing it -- true for every error path in AdminSettings.tsx today, not
// something introduced here. Left as-is there (fixing apiFetch's error
// handling is shared-file, cross-cutting, and out of scope for a UI
// ticket), but the self-lockout 409 text is exactly what an admin needs to
// read in the moment ("You cannot disable your own account"), so it's
// worth unwrapping locally just for this section's errors. Falls back to
// the raw message for anything that isn't a `{error}`-shaped body.
function friendlyError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(err.message) as { error?: unknown };
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON -- fall through to the raw message.
  }
  return err.message || fallback;
}

interface OneTimeReveal {
  username: string;
  password: string;
  mode: 'created' | 'reset';
}

interface CreateForm {
  username: string;
  displayName: string;
  role: UserRole;
  password: string;
}

const DEFAULT_CREATE_FORM: CreateForm = { username: '', displayName: '', role: 'member', password: '' };

export function UsersSection() {
  const { users, loading, error, createUser, updateUser, resetPassword } = useUsers();

  // Needed only to proactively disable this admin's own row controls (the
  // server's self-lockout 409 is the real guard -- see routes/users.ts --
  // this is the "don't even let them try" UX layer on top of it). No
  // existing hook/context exposes the current identity yet (useAuth.ts
  // only tracks the token), so this is fetched locally rather than
  // standing up a global "current user" hook for one field nothing else
  // needs yet.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.auth.me()
      .then((me) => { if (!cancelled) setCurrentUserId(me.id); })
      .catch(() => {
        // Not fatal to the section: worst case, own-row proactive
        // disabling doesn't kick in and the admin has to hit the
        // server's 409 once. The server guard still holds regardless.
      });
    return () => { cancelled = true; };
  }, []);

  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(DEFAULT_CREATE_FORM);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [resetConfirmUser, setResetConfirmUser] = useState<UserOut | null>(null);

  // The one-time-reveal password. Deliberately its own piece of state (not
  // folded into rowError/createError) so dismissing it is an explicit,
  // separate action -- see dismissReveal(). Never logged, never routed
  // through AdminSettings' shared successMessage toast (that renders as a
  // plain string a screenshot could catch later); this section owns its
  // own display and its own dismissal.
  const [reveal, setReveal] = useState<OneTimeReveal | null>(null);
  const [copied, setCopied] = useState(false);

  // Belt-and-suspenders: clear the reveal on unmount too, not just on
  // explicit dismiss. AdminSettings unmounts this whole section when the
  // modal closes (it returns `null` when !isOpen), which already wipes
  // component state, but this guards the same behavior if UsersSection is
  // ever reused somewhere that doesn't unmount-on-close.
  useEffect(() => () => setReveal(null), []);

  function openCreate() {
    setCreateForm(DEFAULT_CREATE_FORM);
    setCreateError(null);
    setCreating(true);
  }

  function cancelCreate() {
    setCreating(false);
    setCreateForm(DEFAULT_CREATE_FORM);
    setCreateError(null);
  }

  async function handleCreate() {
    const username = createForm.username.trim();
    if (!username) {
      setCreateError('Username is required');
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const created = await createUser({
        username,
        role: createForm.role,
        displayName: createForm.displayName.trim() || undefined,
        password: createForm.password.trim() || undefined,
      });
      setCreating(false);
      setCreateForm(DEFAULT_CREATE_FORM);
      if (created.generatedPassword) {
        setReveal({ username: created.username, password: created.generatedPassword, mode: 'created' });
      }
    } catch (err) {
      setCreateError(friendlyError(err, 'Failed to create user'));
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleToggleRole(user: UserOut) {
    setRowBusyId(user.id);
    setRowError(null);
    try {
      await updateUser(user.id, { role: user.role === 'admin' ? 'member' : 'admin' });
    } catch (err) {
      setRowError({ id: user.id, message: friendlyError(err, 'Failed to update role') });
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleToggleDisabled(user: UserOut) {
    setRowBusyId(user.id);
    setRowError(null);
    try {
      await updateUser(user.id, { disabled: !user.disabled });
    } catch (err) {
      setRowError({ id: user.id, message: friendlyError(err, 'Failed to update account status') });
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleResetPassword(user: UserOut) {
    setResetConfirmUser(null);
    setRowBusyId(user.id);
    setRowError(null);
    try {
      const result = await resetPassword(user.id);
      if (result.generatedPassword) {
        setReveal({ username: result.username, password: result.generatedPassword, mode: 'reset' });
      }
    } catch (err) {
      setRowError({ id: user.id, message: friendlyError(err, 'Failed to reset password') });
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleCopy(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (insecure context / permissions
      // denied) -- the password is still visible on screen to copy by
      // hand, so this isn't a hard failure worth surfacing an error for.
    }
  }

  function dismissReveal() {
    setReveal(null);
    setCopied(false);
  }

  return (
    <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-900 dark:text-white">Users</h3>
        {!creating && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            <Plus size={13} /> Add User
          </button>
        )}
      </div>

      {/* ── One-time password reveal ──────────────────────────────────── */}
      {reveal && (
        <div
          role="alert"
          className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4 space-y-3"
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {reveal.mode === 'created' ? 'Account created' : 'Password reset'} for{' '}
              <strong>{reveal.username}</strong>. This password is shown <strong>once</strong> --
              store it in Bitwarden now. It cannot be retrieved again after you close this.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm font-mono bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700 rounded px-3 py-2 break-all">
              {reveal.password}
            </code>
            <button
              onClick={() => handleCopy(reveal.password)}
              title="Copy password"
              className="p-2 rounded-md border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
            >
              {copied ? (
                <CheckCircle size={15} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={15} className="text-amber-700 dark:text-amber-400" />
              )}
            </button>
          </div>
          <button
            onClick={dismissReveal}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors"
          >
            Done — I've stored it
          </button>
        </div>
      )}

      {/* ── Create user form ────────────────────────────────────────────── */}
      {creating && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3 bg-gray-50 dark:bg-gray-700/30">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Username</label>
              <input
                type="text"
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="jdoe"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Display Name <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={createForm.displayName}
                onChange={(e) => setCreateForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="Jane Doe"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Role</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as UserRole }))}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Password <span className="text-gray-400 font-normal">(optional -- leave blank to auto-generate, shown once after creation)</span>
              </label>
              <input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="leave blank to auto-generate"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
          {createError && <p className="text-xs text-red-600 dark:text-red-400">{createError}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={createSubmitting}
              className="px-3 py-1.5 bg-accent text-white text-sm font-medium rounded-md hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {createSubmitting ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={cancelCreate}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* ── User list ────────────────────────────────────────────────────── */}
      {loading && users.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <Loader size={20} className="animate-spin text-accent" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.length === 0 && !loading && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No users yet.</p>
          )}
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            const busy = rowBusyId === user.id;
            return (
              <div
                key={user.id}
                className="border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {user.username}
                      </span>
                      {isSelf && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">(you)</span>
                      )}
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${
                          user.role === 'admin'
                            ? 'bg-accent/10 text-accent'
                            : 'bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-400'
                        }`}
                      >
                        {user.role === 'admin' ? 'Admin' : 'Member'}
                      </span>
                      {user.disabled && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                          Disabled
                        </span>
                      )}
                    </div>
                    {user.displayName && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.displayName}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleToggleRole(user)}
                      disabled={isSelf || busy}
                      title={
                        isSelf
                          ? "You can't change your own role"
                          : user.role === 'admin'
                            ? 'Demote to Member'
                            : 'Promote to Admin'
                      }
                      className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {user.role === 'admin' ? <ShieldOff size={14} /> : <Shield size={14} />}
                    </button>
                    <button
                      onClick={() => setResetConfirmUser(user)}
                      disabled={busy}
                      title="Reset password"
                      className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <KeyRound size={14} />
                    </button>
                    <button
                      onClick={() => handleToggleDisabled(user)}
                      disabled={isSelf || busy}
                      title={
                        isSelf
                          ? "You can't disable your own account"
                          : user.disabled
                            ? 'Enable account'
                            : 'Disable account'
                      }
                      className={`p-1.5 rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                        user.disabled
                          ? 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20'
                          : 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                      }`}
                    >
                      {user.disabled ? <UserCheck size={14} /> : <UserX size={14} />}
                    </button>
                    {busy && <Loader size={14} className="animate-spin text-gray-400" />}
                  </div>
                </div>
                {rowError?.id === user.id && (
                  <p className="text-xs text-red-600 dark:text-red-400">{rowError.message}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Confirm Reset Password Dialog ─────────────────────────────────── */}
      {resetConfirmUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-white">Reset Password</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              This will generate a new password for <strong>{resetConfirmUser.username}</strong> and
              invalidate the old one immediately. The new password is shown once, right after this.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setResetConfirmUser(null)}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleResetPassword(resetConfirmUser)}
                className="flex-1 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
