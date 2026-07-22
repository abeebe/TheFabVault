// Unit test for hooks/useUsers.ts (#2178) -- mirrors useCategories.test.ts's
// shallow "confirm it calls the right api.* method and surfaces the
// result/error" shape, not re-testing api.ts or the server.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUsers } from '../hooks/useUsers.js';

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockResetPassword = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    users: {
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      resetPassword: (...args: unknown[]) => mockResetPassword(...args),
    },
  },
}));

function userRow(overrides: Partial<{
  id: string; username: string; displayName: string | null; role: 'admin' | 'member';
  disabled: boolean; createdAt: number; updatedAt: number;
}> = {}) {
  return {
    id: 'u1', username: 'alice', displayName: null, role: 'member' as const,
    disabled: false, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockResetPassword.mockReset();
});

describe('useUsers', () => {
  it('fetches the user list on mount', async () => {
    mockList.mockResolvedValue([userRow()]);
    const { result } = renderHook(() => useUsers());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].username).toBe('alice');
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error and leaves the list empty when the fetch fails', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('boom');
    expect(result.current.users).toEqual([]);
  });

  it('createUser adds the new row to state, sorted by username', async () => {
    mockList.mockResolvedValue([userRow({ id: 'u2', username: 'zoe' })]);
    mockCreate.mockResolvedValue(userRow({ id: 'u1', username: 'alice' }));
    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createUser({ username: 'alice' });
    });

    expect(mockCreate).toHaveBeenCalledWith({ username: 'alice' });
    expect(result.current.users.map((u) => u.username)).toEqual(['alice', 'zoe']);
  });

  it('createUser propagates a rejection to the caller instead of swallowing it', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockRejectedValue(new Error('Username already taken'));
    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.createUser({ username: 'dup' })).rejects.toThrow('Username already taken');
    // Hook-level error state is untouched -- mutation errors are the
    // caller's responsibility to display (see file header comment).
    expect(result.current.error).toBeNull();
  });

  it('updateUser replaces the row in place', async () => {
    mockList.mockResolvedValue([userRow({ role: 'member' })]);
    mockUpdate.mockResolvedValue(userRow({ role: 'admin' }));
    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateUser('u1', { role: 'admin' });
    });

    expect(mockUpdate).toHaveBeenCalledWith('u1', { role: 'admin' });
    expect(result.current.users[0].role).toBe('admin');
  });

  it('resetPassword replaces the row with the response', async () => {
    mockList.mockResolvedValue([userRow()]);
    mockResetPassword.mockResolvedValue({ ...userRow(), generatedPassword: 'x-y-z' });
    const { result } = renderHook(() => useUsers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let response: Awaited<ReturnType<typeof result.current.resetPassword>> | undefined;
    await act(async () => {
      response = await result.current.resetPassword('u1');
    });

    expect(mockResetPassword).toHaveBeenCalledWith('u1', undefined);
    expect(response?.generatedPassword).toBe('x-y-z');
  });
});
