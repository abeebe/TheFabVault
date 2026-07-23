// Smoke + behavior coverage for UsersSection.tsx (#2178, plan §6). Mocks
// api.users.* and api.auth.me() (real useUsers.ts hook runs underneath,
// same pattern ModelPageCategoryPicker.test.tsx uses for useCategories).
// Assertion style (`.toBeTruthy()` / `.disabled` property / queryBy
// returning null) matches LikeButton.test.tsx and ConvertWizardPage.test.tsx
// -- this repo doesn't have @testing-library/jest-dom installed, so no
// `toBeInTheDocument()`/`toBeDisabled()` matchers.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { UsersSection } from '../components/UsersSection.js';
import type { UserOut } from '../lib/api.js';

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockResetPassword = vi.fn();
const mockMe = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    users: {
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      resetPassword: (...args: unknown[]) => mockResetPassword(...args),
    },
    auth: {
      me: (...args: unknown[]) => mockMe(...args),
    },
  },
}));

function user(overrides: Partial<UserOut> = {}): UserOut {
  return {
    id: 'u1', username: 'alice', displayName: 'Alice Admin', role: 'admin',
    disabled: false, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockResetPassword.mockReset();
  mockMe.mockReset();
  // Default: acting admin is a different user than any row in the tests
  // below, unless a test overrides this to check own-row disabling.
  mockMe.mockResolvedValue({ id: 'acting-admin', username: 'root', displayName: null, role: 'admin' });
});

afterEach(cleanup);

describe('UsersSection (#2178)', () => {
  it('renders the user list with role and disabled badges', async () => {
    mockList.mockResolvedValue([
      user({ id: 'u1', username: 'alice', role: 'admin', disabled: false }),
      user({ id: 'u2', username: 'bob', displayName: null, role: 'member', disabled: true }),
    ]);
    render(<UsersSection />);

    await screen.findByText('alice');
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getAllByText('Admin')).toHaveLength(1);
    expect(screen.getAllByText('Member')).toHaveLength(1);
    expect(screen.getByText('Disabled')).toBeTruthy();
  });

  it('creates a user and shows the generated password exactly once, with a dismiss control', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue(
      { ...user({ id: 'u3', username: 'newperson', role: 'member' }), generatedPassword: 'g3n-pw-123' },
    );
    render(<UsersSection />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /add user/i }));
    fireEvent.change(screen.getByPlaceholderText('jdoe'), { target: { value: 'newperson' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'newperson', role: 'member' }),
    ));

    // Password is shown once, in the reveal panel.
    expect(await screen.findByText('g3n-pw-123')).toBeTruthy();
    expect(screen.getByText(/shown/i)).toBeTruthy();

    // Dismissing clears it -- it does not linger after the admin
    // acknowledges they've stored it.
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByText('g3n-pw-123')).toBeNull();
  });

  it('does not show a reveal panel when the admin supplied their own password', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue(user({ id: 'u4', username: 'withpw', role: 'member' }));
    render(<UsersSection />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /add user/i }));
    fireEvent.change(screen.getByPlaceholderText('jdoe'), { target: { value: 'withpw' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(screen.queryByText(/shown/i)).toBeNull();
  });

  it('reveals a reset password once behind a confirm step', async () => {
    mockList.mockResolvedValue([user({ id: 'u1', username: 'alice' })]);
    mockResetPassword.mockResolvedValue({ ...user({ id: 'u1', username: 'alice' }), generatedPassword: 'reset-pw-9' });
    render(<UsersSection />);
    await screen.findByText('alice');

    fireEvent.click(screen.getByTitle('Reset password'));
    // Confirm dialog gates the actual reset call.
    expect(mockResetPassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));

    await waitFor(() => expect(mockResetPassword).toHaveBeenCalledWith('u1', undefined));
    expect(await screen.findByText('reset-pw-9')).toBeTruthy();
  });

  it("disables the acting admin's own row/role/disable controls", async () => {
    mockMe.mockResolvedValue({ id: 'u1', username: 'alice', displayName: null, role: 'admin' });
    mockList.mockResolvedValue([
      user({ id: 'u1', username: 'alice', role: 'admin' }),
      user({ id: 'u2', username: 'bob', role: 'member' }),
    ]);
    render(<UsersSection />);
    await screen.findByText('alice');
    await screen.findByText('(you)');

    // alice (self) -- both the role toggle and the disable toggle are
    // proactively disabled, per the ticket's "disable the controls on
    // your own row" requirement (on top of the server's 409 guard).
    const aliceRoleButton = screen.getByTitle("You can't change your own role") as HTMLButtonElement;
    expect(aliceRoleButton.disabled).toBe(true);
    const aliceDisableButton = screen.getByTitle("You can't disable your own account") as HTMLButtonElement;
    expect(aliceDisableButton.disabled).toBe(true);

    // bob (not self) -- both controls stay enabled.
    const bobRoleButton = screen.getByTitle('Promote to Admin') as HTMLButtonElement;
    expect(bobRoleButton.disabled).toBe(false);
    const bobDisableButton = screen.getByTitle('Disable account') as HTMLButtonElement;
    expect(bobDisableButton.disabled).toBe(false);
  });

  it('surfaces a role-toggle failure inline on that row without clobbering the list', async () => {
    mockList.mockResolvedValue([
      user({ id: 'u1', username: 'alice', role: 'admin' }),
      user({ id: 'u2', username: 'bob', role: 'member' }),
    ]);
    // #2181: apiFetch now unwraps `{error: string}` JSON bodies itself,
    // so api.users.update() (which this mock stands in for) rejects with
    // the plain message already -- not the raw JSON blob this test used
    // to simulate pre-fix.
    mockUpdate.mockRejectedValue(new Error('You cannot demote your own account'));
    render(<UsersSection />);
    await screen.findByText('bob');

    fireEvent.click(screen.getByTitle('Promote to Admin'));

    expect(await screen.findByText('You cannot demote your own account')).toBeTruthy();
    // Both rows are still rendered -- a row-scoped error didn't wipe the list.
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });
});
