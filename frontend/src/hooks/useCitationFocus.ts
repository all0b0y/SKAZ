import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a cited fragment stays highlighted after a jump to it. */
export const CITATION_FOCUS_MS = 2000;

/**
 * A jump to a cited transcript fragment is a one-shot event, not a lasting
 * state: the fragment is lit for a moment and then the focus is gone, and
 * leaving the transcript drops it at once. Otherwise every later return to the
 * transcript would jump back to an old citation and lose the reading place.
 */
export interface CitationFocus {
  segmentId: string;
  /** The session whose transcript the jump is for; any other transcript ignores it. */
  sessionId: string | null;
}

export function useCitationFocus() {
  const [focus, setFocus] = useState<CitationFocus | null>(null);
  const expire = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retrigger = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopTimers = () => {
    clearTimeout(expire.current);
    clearTimeout(retrigger.current);
  };

  const cite = useCallback((segmentId: string, sessionId: string | null) => {
    stopTimers();
    // Cleared first, set on the next tick: a repeat click on the same citation
    // must reach the transcript as a new jump, not as an unchanged prop.
    setFocus(null);
    retrigger.current = setTimeout(() => {
      setFocus({ segmentId, sessionId });
      expire.current = setTimeout(() => setFocus(null), CITATION_FOCUS_MS);
    }, 0);
  }, []);

  /** The reader left the transcript (another tab or session). */
  const clear = useCallback(() => {
    stopTimers();
    setFocus(null);
  }, []);

  useEffect(() => stopTimers, []);

  return { focus, cite, clear };
}
