/**
 * UI sounds (DESIGN-SYSTEM.md, decision 16). Three events, «subtle» only, off by default:
 * an answer is ready, an import / materials job finished, something failed and needs the user.
 * Answer and materials sound only when the window is not in focus or the work took longer than
 * ~5 s; an error always does. Silent while a recording captures the computer's sound, until the
 * user has verified that the loopback does not record SKAZ's own output. Pure: no DOM, no audio.
 */

export type UiSound = 'answer' | 'materials' | 'error';

export const LONG_MS = 5000;

export interface SoundContext {
  enabled: boolean;
  focused: boolean;
  /** How long the finished work took (0 when unknown). */
  tookMs: number;
  /** A recording is capturing the computer's sound right now. */
  capturingSystemAudio: boolean;
}

export function shouldPlay(sound: UiSound, ctx: SoundContext): boolean {
  if (!ctx.enabled || ctx.capturingSystemAudio) return false;
  if (sound === 'error') return true;
  return !ctx.focused || ctx.tookMs > LONG_MS;
}

export interface Tracked { state: string; since: number }
export interface SoundEvent { sound: UiSound; tookMs: number }

/**
 * Compare what is shown now with what was shown before and say which work just finished.
 * Only a change seen from a running state counts: history loaded later never plays anything.
 */
export function finished(
  prev: ReadonlyMap<string, Tracked>,
  now: ReadonlyArray<{ id: string; state: string }>,
  running: (state: string) => boolean,
  done: (state: string) => UiSound | null,
  at: number,
): { next: Map<string, Tracked>; events: SoundEvent[] } {
  const next = new Map<string, Tracked>();
  const events: SoundEvent[] = [];
  for (const item of now) {
    const before = prev.get(item.id);
    if (before && before.state === item.state) { next.set(item.id, before); continue; }
    next.set(item.id, { state: item.state, since: at });
    if (before && running(before.state)) {
      const sound = done(item.state);
      if (sound) events.push({ sound, tookMs: at - before.since });
    }
  }
  return { next, events };
}

/** Assistant messages: streaming → done is an answer, → failed an error (interrupted/cancelled: the user did it). */
export const answerRunning = (s: string) => s === 'streaming';
export const answerDone = (s: string): UiSound | null => (s === 'done' ? 'answer' : s === 'failed' ? 'error' : null);

/** Materials: processing (file or wiki) → ready / in wiki is done, → failed an error. */
export const materialRunning = (s: string) => s === 'processing' || s === 'queued';
export const materialDone = (s: string): UiSound | null =>
  (s === 'ready' || s === 'in_wiki' ? 'materials' : s === 'failed' ? 'error' : null);
