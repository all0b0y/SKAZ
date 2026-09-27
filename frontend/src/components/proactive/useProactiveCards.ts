import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient } from '../../api/client';
import type { ProactiveCard, ProactiveView } from '../../api/types';

/** Fast enough for the ≤ 3 s card target on top of the backend's own scan. */
export const PROACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

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
 * Cards for one session. Polls every second while capturing or while a card is
 * still changing, and announces each NEW card once: a system notification
 * without any content when SKAZ is not focused, a chime when it is and sound is on.
 * Cards that already existed when the session was opened are never announced.
 */
export function useProactiveCards(sessionId: string | null, enabled: boolean, capturing: boolean) {
  const [view, setView] = useState<ProactiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const viewRef = useRef<ProactiveView | null>(null);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const [tick, setTick] = useState(0);

  const accept = useCallback((next: ProactiveView) => {
    const known = seen.current;
    const fresh = known ? next.cards.filter((card) => !known.has(card.id)) : [];
    seen.current = new Set(next.cards.map((card) => card.id));
    viewRef.current = next;
    setView(next);
    if (fresh.length) {
      if (!document.hasFocus()) window.skaz.notifyProactive?.(next.sound);
      else if (next.sound) chime();
    }
  }, []);

  useEffect(() => {
    seen.current = null;
    viewRef.current = null;
    setView(null);
    setError(null);
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    const api = new ApiClient(window.skaz);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api.getProactive(sessionId);
        if (!alive) return;
        setError(null);
        accept(next);
      } catch {
        if (alive) setError('Could not refresh the proactive assistant.');
      }
      if (!alive) return;
      const current = viewRef.current;
      const active = capturingRef.current || (current?.cards.some(busy) ?? false);
      timer = setTimeout(() => void poll(), active ? PROACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [sessionId, enabled, accept, tick]);

  // Capture starting is exactly when a fast poll matters: restart the loop.
  useEffect(() => { if (capturing) setTick((value) => value + 1); }, [capturing]);

  return { view, error, accept };
}
