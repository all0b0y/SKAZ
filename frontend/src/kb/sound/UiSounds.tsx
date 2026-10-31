import { useEffect } from 'react';
import answerUrl from '../../assets/sounds/answer.wav';
import errorUrl from '../../assets/sounds/error.wav';
import materialsUrl from '../../assets/sounds/materials.wav';
import { isLive } from '../recording/recordingStore';
import { useServices } from '../state/context';
import {
  answerDone, answerRunning, finished, materialDone, materialRunning, shouldPlay, type SoundEvent, type Tracked, type UiSound,
} from './soundRules';

/**
 * Plays the three UI sounds (Settings → Appearance → Sounds). Watches the stores the app already
 * has: assistant messages (answer ready / failed) and materials (file and wiki processing). The
 * files are bundled (rendered from .dev/ui-redesign/design-system/synth.py, one loudness); they
 * follow the system volume at a quiet fixed level.
 */

const URLS: Record<UiSound, string> = { answer: answerUrl, materials: materialsUrl, error: errorUrl };
const VOLUME = 0.35;
/** One import finishes twice (file, then wiki): one sound per kind within this window. */
const REPEAT_MS = 3000;

export function UiSounds() {
  const { chats, library, recording, prefs } = useServices();
  useEffect(() => {
    let answers = new Map<string, Tracked>();
    let materials = new Map<string, Tracked>();
    const lastPlayed: Partial<Record<UiSound, number>> = {};
    const play = (events: SoundEvent[]) => {
      for (const e of events) {
        const rec = recording.getState();
        const ok = shouldPlay(e.sound, {
          enabled: prefs.getState().sounds === 'subtle',
          focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
          tookMs: e.tookMs,
          capturingSystemAudio: isLive(rec.phase) && rec.options.systemAudio,
        });
        const now = Date.now();
        if (!ok || now - (lastPlayed[e.sound] ?? 0) < REPEAT_MS) continue;
        lastPlayed[e.sound] = now;
        try {
          const audio = new Audio(URLS[e.sound]);
          audio.volume = VOLUME;
          void audio.play().catch(() => undefined);
        } catch { /* no audio output: stay silent */ }
      }
    };
    const onChats = (s: ReturnType<typeof chats.getState>) => {
      const items = Object.values(s.chats).flatMap((open) => open.chat?.messages ?? [])
        .filter((m) => m.role === 'assistant').map((m) => ({ id: m.id, state: m.state }));
      const r = finished(answers, items, answerRunning, answerDone, Date.now());
      answers = r.next;
      play(r.events);
    };
    const onLibrary = (s: ReturnType<typeof library.getState>) => {
      const items = s.materials.flatMap((m) => [
        { id: `${m.id}:file`, state: m.status },
        { id: `${m.id}:wiki`, state: m.wiki_state ?? '' },
      ]);
      const r = finished(materials, items, materialRunning, materialDone, Date.now());
      materials = r.next;
      play(r.events);
    };
    // Seed with what is already shown: history never plays.
    onChats(chats.getState());
    onLibrary(library.getState());
    const offChats = chats.subscribe(onChats);
    const offLibrary = library.subscribe(onLibrary);
    return () => { offChats(); offLibrary(); };
  }, [chats, library, recording, prefs]);
  return null;
}
