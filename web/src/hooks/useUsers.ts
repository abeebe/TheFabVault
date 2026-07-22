import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type {
  UserOut, UserCreateBody, UserCreateResponse, UserUpdateBody, UserResetPasswordBody,
} from '../lib/api.js';

// Users tab (Phase D2, #2178), same list+loading+error+refresh shape as
// useCategories.ts/useAssets.ts. Unlike useCategories (read-only -- nothing
// calls its mutations yet), this hook also wraps create/update/resetPassword
// because UsersSection.tsx (its one consumer) needs all three. Mutation
// errors are intentionally NOT written into this hook's `error` state and
// are left for the caller to catch -- UsersSection ties them to specific UI
// (the create-form's own error line, a single row's error line) rather than
// one section-wide error banner, so a failed row action doesn't blank out
// an unrelated create-form in progress.
export function useUsers() {
  const [users, setUsers] = useState<UserOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.users.list();
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createUser = useCallback(async (body: UserCreateBody): Promise<UserCreateResponse> => {
    const created = await api.users.create(body);
    setUsers((prev) => [...prev, created].sort((a, b) => a.username.localeCompare(b.username)));
    return created;
  }, []);

  const updateUser = useCallback(async (id: string, body: UserUpdateBody): Promise<UserOut> => {
    const updated = await api.users.update(id, body);
    setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    return updated;
  }, []);

  const resetPassword = useCallback(
    async (id: string, body?: UserResetPasswordBody): Promise<UserCreateResponse> => {
      const result = await api.users.resetPassword(id, body);
      // resetPassword's response is a full UserOut (+ optional
      // generatedPassword) -- refresh the row from it so updatedAt stays
      // accurate even though role/displayName/disabled didn't change.
      setUsers((prev) => prev.map((u) => (u.id === id ? result : u)));
      return result;
    },
    [],
  );

  return { users, loading, error, refresh, createUser, updateUser, resetPassword };
}
