import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { ProactiveCard, ProactiveView } from '../../api/types';

/**
 * Fallback polling only. Cards arrive by push: Electron main follows the
 * backend's feed and tells the window the moment a session's cards change.
 */
export const PROACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 10_000;

const busy = (card: ProactiveCard): boolean =>
  card.status === 'listening' || card.status === 'answering' || card.web?.status === 'awaiting_approval';

/** A short, quiet chime for a new card while SKAZ is in focus (only when sound is on). */
function chime(): void {
  try {
    const Context = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const audio = new Context();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.04, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 0.25);
    tone.onended = () => { void audio.close(); };
  } catch {
    // No audio output is not an error worth showing.
  }
}

/**
 * Cards for one session. Refetched the moment main reports a change for this
 * session, with a slow poll as a fallback. The out-of-focus system notification
 * belongs to main; while SKAZ is focused a new card only chimes, if sound is on.
 * Cards that already existed when the session was opened are never announced.
 */
export function useProactiveCards(sessionId: string | null, enabled: boolean, capturing: boolean) {
  const [view, setView] = useState<ProactiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const viewRef = useRef<ProactiveView | null>(null);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const refresh = useRef<() => void>(() => {});

  const accept = useCallback((next: ProactiveView) => {
    const known = seen.current;
    const fresh = known ? next.cards.filter((card) => !known.has(card.id)) : [];
    seen.current = new Set(next.cards.map((card) => card.id));
    viewRef.current = next;
    setView(next);
    if (fresh.length && next.sound && document.hasFocus()) chime();
  }, []);

  useEffect(() => {
    seen.current = null;
    viewRef.current = null;
    setView(null);
    setError(null);
    if (!sessionId || !enabled) return;
    const api = new ApiClient(window.skaz);
    let alive = true;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (running) { again = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        const next = await api.getProactive(sessionId);
        if (!alive) return;
        setError(null);
        accept(next);
      } catch {
        if (alive) setError('Could not refresh the proactive assistant.');
      } finally {
        running = false;
      }
      if (!alive) return;
      if (again) { again = false; void poll(); return; }
      const active = capturingRef.current || (viewRef.current?.cards.some(busy) ?? false);
      timer = setTimeout(() => void poll(), active ? PROACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    refresh.current = () => void poll();
    const unsubscribe = window.skaz.onProactiveChanged?.((sessionIds) => {
      if (sessionIds.includes(sessionId)) void poll();
    });
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe?.();
      refresh.current = () => {};
    };
  }, [sessionId, enabled, accept]);

  // Capture starting is exactly when fresh cards matter: read them now.
  useEffect(() => { if (capturing) refresh.current(); }, [capturing]);

  return { view, error, accept };
}
