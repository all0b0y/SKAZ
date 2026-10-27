import { useEffect, useRef } from 'react';
import { createServices, type KbServices } from '../state/context';
import { PREFS_KEY, type Prefs } from '../state/prefs';
import { createBrowserFake } from '../test/browserFake';
import type { FakeWorld } from '../test/fakeKb';
import type { BoardLook } from './route';

/**
 * The live part of board frames (layers 3–4): real stores over the browser fake backend
 * (test/browserFake.ts — the same one the U2 harness uses), each frame with its own storage, so
 * frames side by side on the canvas never share prefs, drafts or folds (iframes of one origin
 * share localStorage).
 */

/** A Storage kept in memory (one per services instance). */
export function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

/** The prefs a frame starts with: the frame's look, onboarding done unless the frame says otherwise. */
export function lookPrefs(look: BoardLook, extra: Partial<Prefs> = {}): Partial<Prefs> {
  return {
    onboardingDone: true, theme: look.theme, textSize: look.size, base: look.base, accent: look.accent, density: look.density,
    motion: 'full', sounds: 'off', ...extra,
  };
}

export function boardServices(world: FakeWorld, prefs: Partial<Prefs>): { services: KbServices; world: FakeWorld } {
  const fake = createBrowserFake(world);
  const storage = memoryStorage({ [PREFS_KEY]: JSON.stringify(prefs) });
  return { services: createServices(fake.bridge, storage, { capture: null }), world: fake.world };
}

/**
 * What the app reads at start (KbApp's useLiveData, without the long polls): library, agents,
 * settings health, then the lists of a connected library. Components shown on their own need it;
 * the whole app (layer 4) does it itself.
 */
export async function warmUp(s: KbServices): Promise<void> {
  const st = s.settings.getState();
  await Promise.all([s.library.getState().loadLibrary(), s.agents.getState().refresh(), st.loadHealth(), st.loadWiki(), st.loadSpeech()]);
  if (s.library.getState().library?.state !== 'ready') return;
  await Promise.all([s.library.getState().loadContent(), s.chats.getState().loadList(), s.notifications.getState().refresh()]);
}

/** Tell the canvas how tall this frame is (key = which iframe), so it shows the frame whole. */
export function useReportHeight(key: string, fixed: boolean): void {
  useEffect(() => {
    if (fixed || window.parent === window || typeof ResizeObserver === 'undefined') return undefined;
    const send = () => window.parent.postMessage({ kbBoard: 'height', key, height: document.documentElement.scrollHeight }, window.location.origin);
    const obs = new ResizeObserver(send);
    obs.observe(document.body);
    send();
    return () => obs.disconnect();
  }, [key, fixed]);
}

/** How long a frame waits after its data is in before it calls itself ready (springs settle). */
export const SETTLE_MS = 500;

/** `<html data-board-ready>`: the screenshot script waits for it. */
export function markReady(errors: readonly string[] = []): void {
  const html = document.documentElement;
  if (errors.length) html.dataset.boardErrors = errors.join(' | ');
  window.setTimeout(() => {
    html.dataset.boardReady = 'true';
    // The canvas loads its frames a few at a time: this one (its address) is done, the next may start.
    if (window.parent !== window) window.parent.postMessage({ kbBoard: 'ready', hash: window.location.hash }, window.location.origin);
  }, SETTLE_MS);
}

/** Wait until the stores' answers (the fake answers after 30 ms) and the renders after them are in. */
export const settle = (ms = 120) => new Promise<void>((r) => { window.setTimeout(r, ms); });

/** Run `job` once per mounted cell, StrictMode's second effect pass included; report to the latest `then`. */
export function useOnce(start: boolean, job: () => Promise<void>, then: (error?: string) => void): void {
  const running = useRef<Promise<void> | null>(null);
  const latest = useRef(then);
  latest.current = then;
  useEffect(() => {
    if (!start) return undefined;
    running.current ??= job();
    let on = true;
    running.current.then(() => { if (on) latest.current(); }, (e: unknown) => { if (on) latest.current(String(e)); });
    return () => { on = false; };
  }, [start]); // eslint-disable-line react-hooks/exhaustive-deps
}

