import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a Copy button says «Copied» (✓) before it is a Copy button again. */
export const COPIED_MS = 1600;

/**
 * The «Copied» state of a Copy button: true for {@link COPIED_MS} after a successful copy, then back to false.
 * Copying again restarts the time. `mark(false)` (the copy failed) clears it at once.
 */
export function useCopied(ms: number = COPIED_MS): [boolean, (ok: boolean) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const mark = useCallback((ok: boolean) => {
    window.clearTimeout(timer.current);
    setCopied(ok);
    if (ok) timer.current = window.setTimeout(() => setCopied(false), ms);
  }, [ms]);
  return [copied, mark];
}
