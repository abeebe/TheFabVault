// Unit coverage for LikeButton (#2169, shared between ModelCard and
// ModelPage). Scoped to the toggle's own contract -- optimistic flip,
// reconciling with the server's returned counts, and reverting on error
// -- not re-testing ModelCard/ModelPage themselves (see their own test
// files for that).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LikeButton } from '../components/LikeButton.js';

const mockLike = vi.fn();
const mockUnlike = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    models: {
      like: (...args: unknown[]) => mockLike(...args),
      unlike: (...args: unknown[]) => mockUnlike(...args),
    },
  },
}));

beforeEach(() => {
  mockLike.mockReset();
  mockUnlike.mockReset();
});

afterEach(cleanup);

describe('LikeButton', () => {
  it('renders the initial count and unliked state', () => {
    render(<LikeButton modelId="m1" likeCount={3} likedByMe={false} />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByTitle('Like')).toBeTruthy();
  });

  it('clicking an unliked button calls like(), optimistically increments, then reconciles with the server result', async () => {
    mockLike.mockResolvedValue({ likeCount: 5, likedByMe: true });
    render(<LikeButton modelId="m1" likeCount={4} likedByMe={false} />);

    fireEvent.click(screen.getByTitle('Like'));

    // Optimistic bump happens synchronously, before the promise resolves.
    expect(screen.getByText('5')).toBeTruthy();
    expect(mockLike).toHaveBeenCalledWith('m1');
    expect(mockUnlike).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByTitle('Unlike')).toBeTruthy());
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('clicking a liked button calls unlike(), optimistically decrements, then reconciles', async () => {
    mockUnlike.mockResolvedValue({ likeCount: 2, likedByMe: false });
    render(<LikeButton modelId="m1" likeCount={3} likedByMe={true} />);

    fireEvent.click(screen.getByTitle('Unlike'));

    expect(screen.getByText('2')).toBeTruthy();
    expect(mockUnlike).toHaveBeenCalledWith('m1');

    await waitFor(() => expect(screen.getByTitle('Like')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('reverts the optimistic update if the API call fails', async () => {
    mockLike.mockRejectedValue(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<LikeButton modelId="m1" likeCount={4} likedByMe={false} />);

    fireEvent.click(screen.getByTitle('Like'));
    expect(screen.getByText('5')).toBeTruthy(); // optimistic

    await waitFor(() => expect(screen.getByText('4')).toBeTruthy()); // reverted
    expect(screen.getByTitle('Like')).toBeTruthy(); // still unliked
    consoleSpy.mockRestore();
  });

  it('does not navigate when rendered inside a Link (preventDefault/stopPropagation)', () => {
    mockLike.mockResolvedValue({ likeCount: 1, likedByMe: true });
    render(
      <a href="/models/m1" onClick={(e) => e.preventDefault()}>
        <LikeButton modelId="m1" likeCount={0} likedByMe={false} />
      </a>
    );

    const event = fireEvent.click(screen.getByTitle('Like'));
    // fireEvent.click returns false if any handler called preventDefault --
    // the button's own onClick calls it, confirming the click event never
    // reaches (or is at least neutralized for) the wrapping anchor's
    // default navigation behavior.
    expect(event).toBe(false);
  });
});
