import { useEffect, useState } from 'react';

/** Frames that load at once on layers 3–4: each is a whole app instance on the dev server. */
export const AT_ONCE = 3;
/** A frame that never says it is ready doesn't hold the queue longer than this. */
export const STALL_MS = 6000;

interface QueueState {
  /** The order this state belongs to (`order.join`): a new order starts the queue over. */
  reset: string;
  /** Frames (hashes) that said they are ready while loaded under this order. */
  ready: ReadonlySet<string>;
  /** Frames let in by STALL_MS without a ready. */
  stalls: number;
}

/**
 * How many frames of `order` may have an address: AT_ONCE, one more per stall, and one more per
 * frame that is ready among those already let in (counted until nothing changes).
 */
export function allowedCount(order: readonly string[], ready: ReadonlySet<string>, stalls: number): number {
  let n = Math.min(order.length, AT_ONCE + stalls);
  for (;;) {
    let r = 0;
    for (let i = 0; i < n; i++) if (ready.has(order[i]!)) r++;
    const next = Math.min(order.length, AT_ONCE + stalls + r);
    if (next <= n) return n;
    n = next;
  }
}

/** The state for a new order: only frames that stay loaded through the change keep their ready. */
function startOver(order: readonly string[], reset: string, ready: ReadonlySet<string>): QueueState {
  const n = allowedCount(order, ready, 0);
  return { reset, ready: new Set(order.slice(0, n).filter((h) => ready.has(h))), stalls: 0 };
}

/**
 * Frames load a few at a time, in canvas order: the next starts when one says it is ready (its
 * `{ kbBoard: 'ready', hash }` message, live.ts markReady) or after STALL_MS without progress.
 * `order` = the hashes of the queued canvas frames. A new order starts over in the same render
 * (state `{reset, …}` compared while rendering, not in an effect a render later); a ready counts
 * once and only from a frame that is loaded now, so readies of an earlier canvas never open frames
 * of this one; the stall timer runs only while frames still wait. Dev-only (kb/board).
 */
export function useFrameQueue(order: readonly string[]): (hash: string) => boolean {
  const reset = order.join('\n');
  const [state, setState] = useState<QueueState>(() => ({ reset, ready: new Set(), stalls: 0 }));
  // React's «adjust state while rendering»: this render already uses the new order's queue.
  let q = state;
  if (q.reset !== reset) {
    q = startOver(order, reset, q.ready);
    setState(q);
  }
  const allowed = allowedCount(order, q.ready, q.stalls);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const d = event.data as { kbBoard?: string; hash?: unknown };
      if (d?.kbBoard !== 'ready' || typeof d.hash !== 'string') return;
      const hash = d.hash;
      setState((now) => {
        if (now.reset !== reset || now.ready.has(hash)) return now;
        const at = order.indexOf(hash);
        if (at < 0 || at >= allowedCount(order, now.ready, now.stalls)) return now;
        return { ...now, ready: new Set(now.ready).add(hash) };
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [reset]); // eslint-disable-line react-hooks/exhaustive-deps -- `order` is `reset`

  // One timer at a time, re-armed by every step of the queue, none once every frame may load.
  useEffect(() => {
    if (allowed >= order.length) return undefined;
    const timer = window.setTimeout(() => {
      setState((now) => (now.reset === reset ? { ...now, stalls: now.stalls + 1 } : now));
    }, STALL_MS);
    return () => window.clearTimeout(timer);
  }, [reset, allowed, order.length]);

  return (hash) => {
    const at = order.indexOf(hash);
    return at >= 0 && at < allowed;
  };
}
