// Coverage for useMe.tsx (Phase D4, #2180, plan §6) -- the shared
// identity/role context every other D4 gate (RequireAdmin, ModelPage's/
// CollectionPage's canEdit) reads from. Mirrors UsersSection.test.tsx's
// assertion style (`.toBeTruthy()`, no jest-dom matchers -- this repo
// doesn't have that package installed).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MeProvider, useMe } from '../hooks/useMe.js';
import type { AuthMeOut } from '../lib/api.js';

const mockMe = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    auth: {
      me: (...args: unknown[]) => mockMe(...args),
    },
  },
}));

// Minimal consumer that surfaces every field of the context as text --
// simpler than reaching into RequireAdmin/ModelPage for this file's
// purposes, which is the context's own contract, not a specific
// consumer's UI.
function Probe() {
  const { me, loading, error, isAdmin } = useMe();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="isAdmin">{String(isAdmin)}</span>
      <span data-testid="error">{error ?? 'null'}</span>
      <span data-testid="me">{me ? me.username : 'null'}</span>
    </div>
  );
}

// Toggle harness for the isAuthenticated-flip test below -- MeProvider's
// `isAuthenticated` prop can only change via a re-render from its parent
// (it's not itself stateful), so this owns that state and exposes a
// button to flip it.
function ToggleHarness() {
  const [authed, setAuthed] = useState(true);
  return (
    <div>
      <button onClick={() => setAuthed((a) => !a)}>toggle</button>
      <MeProvider isAuthenticated={authed}>
        <Probe />
      </MeProvider>
    </div>
  );
}

function adminUser(): AuthMeOut {
  return { id: 'admin1', username: 'root', displayName: null, role: 'admin' };
}

function memberUser(): AuthMeOut {
  return { id: 'member1', username: 'bob', displayName: null, role: 'member' };
}

beforeEach(() => {
  mockMe.mockReset();
});

afterEach(cleanup);

describe('useMe / MeProvider (#2180)', () => {
  it('fetches /auth/me on mount when isAuthenticated and exposes the result', async () => {
    mockMe.mockResolvedValue(adminUser());
    render(<MeProvider isAuthenticated={true}><Probe /></MeProvider>);

    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('root'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe('null');
    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  it('computes isAdmin: false for a member role', async () => {
    mockMe.mockResolvedValue(memberUser());
    render(<MeProvider isAuthenticated={true}><Probe /></MeProvider>);

    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('bob'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
  });

  it('does not fetch when isAuthenticated is false', async () => {
    render(<MeProvider isAuthenticated={false}><Probe /></MeProvider>);

    // Give any accidental effect a tick to fire, then assert it didn't.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockMe).not.toHaveBeenCalled();
    expect(screen.getByTestId('me').textContent).toBe('null');
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
  });

  it('treats a fetch failure as least-privilege (member view), not a crash', async () => {
    mockMe.mockRejectedValue(new Error('network blip'));
    render(<MeProvider isAuthenticated={true}><Probe /></MeProvider>);

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('network blip'));
    expect(screen.getByTestId('me').textContent).toBe('null');
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
  });

  it('clears the held identity when isAuthenticated flips false (logout)', async () => {
    mockMe.mockResolvedValue(adminUser());
    render(<ToggleHarness />);

    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('root'));

    screen.getByRole('button', { name: 'toggle' }).click();

    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('null'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
  });

  it('re-fetches when isAuthenticated flips back true after a logout (new login)', async () => {
    mockMe.mockResolvedValueOnce(adminUser()).mockResolvedValueOnce(memberUser());
    render(<ToggleHarness />);
    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('root'));

    screen.getByRole('button', { name: 'toggle' }).click(); // logout
    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('null'));

    screen.getByRole('button', { name: 'toggle' }).click(); // login again
    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('bob'));
    expect(mockMe).toHaveBeenCalledTimes(2);
  });

  it('a consumer rendered with no MeProvider gets the least-privilege default, not a crash', () => {
    // No provider at all -- exercises the module-level default context
    // value (see useMe.tsx's LEAST_PRIVILEGE constant).
    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
    expect(screen.getByTestId('me').textContent).toBe('null');
  });
});
