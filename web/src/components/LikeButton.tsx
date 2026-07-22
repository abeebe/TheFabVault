import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { api } from '../lib/api.js';

interface Props {
  modelId: string;
  likeCount: number;
  likedByMe: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

// Shared like/unlike control for ModelCard (grid tiles, wrapped in a
// react-router <Link>) and ModelPage's header (not wrapped in anything).
// State is self-contained rather than lifted -- likeCount/likedByMe seed
// the initial render from whatever list/detail fetch produced the parent
// ModelOut, and every click afterward is optimistic: flip immediately,
// call api.models.like/unlike, and reconcile with the server's returned
// { likeCount, likedByMe } (or revert on error). This is deliberately
// simpler than threading the toggle back through useModels/useModel to
// splice the parent's model array/detail record -- a like/unlike is a
// narrow, self-contained side effect, not a change to the rest of the
// model, so there's nothing else on screen that needs to know about it.
export function LikeButton({ modelId, likeCount, likedByMe, size = 'sm', className = '' }: Props) {
  const [count, setCount] = useState(likeCount);
  const [liked, setLiked] = useState(likedByMe);
  const [pending, setPending] = useState(false);

  // Re-seed if the parent re-renders with a fresh model (e.g. navigating
  // to a different model, or a refresh() elsewhere in the same page) --
  // this is the same "sync from props on change" idiom TagInput and
  // ModelPage's own Edit Details form use for their local drafts.
  useEffect(() => {
    setCount(likeCount);
    setLiked(likedByMe);
  }, [likeCount, likedByMe]);

  async function toggle(e: React.MouseEvent) {
    // ModelCard renders this inside a <Link to={`/models/${id}`}> --
    // without these, every like click would also navigate to the model
    // page. Harmless (but unnecessary) when used from ModelPage's header,
    // which isn't inside a Link.
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;

    const wasLiked = liked;
    const prevCount = count;
    setPending(true);
    setLiked(!wasLiked);
    setCount(wasLiked ? prevCount - 1 : prevCount + 1);

    try {
      const result = wasLiked ? await api.models.unlike(modelId) : await api.models.like(modelId);
      setLiked(result.likedByMe);
      setCount(result.likeCount);
    } catch (err) {
      console.error('[LikeButton] Failed to toggle like:', err);
      setLiked(wasLiked);
      setCount(prevCount);
    } finally {
      setPending(false);
    }
  }

  const iconSize = size === 'sm' ? 12 : 16;

  return (
    <button
      onClick={toggle}
      disabled={pending}
      title={liked ? 'Unlike' : 'Like'}
      className={`inline-flex items-center gap-1 rounded-full transition-colors disabled:opacity-60 ${
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
      } ${
        liked
          ? 'text-red-500'
          : 'text-gray-400 hover:text-red-500'
      } ${className}`}
    >
      <Heart size={iconSize} className={liked ? 'fill-current' : ''} />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
