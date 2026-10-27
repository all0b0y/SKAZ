import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  ACCENTS, BASES, DEFAULT_LOOK, DENSITIES, MOTIONS, SOUNDS,
  type AccentPref, type BasePref, type DensityPref, type MotionPref, type SoundsPref,
} from './appearance';

/**
 * Renderer-only preferences of the new interface (no secrets, no content).
 * Persisted to localStorage under one key. Languages live here only until the backend has a
 * settings route for the new model (see report Q: /kb/settings).
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type TextSize = 's' | 'm' | 'l';
export type Section = 'chats' | 'materials' | 'wiki' | 'graph' | 'notifications';

export const SIDE_MIN = 200;
export const SIDE_MAX = 360;
export const SIDE_DEFAULT = 248;
export const RIGHT_MIN = 320;
export const RIGHT_MAX = 640;
export const RIGHT_DEFAULT = 400;

export interface Prefs {
  theme: ThemePref;
  textSize: TextSize;
  section: Section;
  sideOpen: boolean;
  sideWidth: number;
  rightWidth: number;
  onboardingDone: boolean;
  /** Appearance knobs (DESIGN-SYSTEM.md); mirrored onto <html> by KbApp's ThemeSync. */
  base: BasePref;
  accent: AccentPref;
  density: DensityPref;
  motion: MotionPref;
  sounds: SoundsPref;
}

export const PREFS_KEY = 'skaz.kb.prefs';

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  textSize: 'm',
  section: 'chats',
  sideOpen: true,
  sideWidth: SIDE_DEFAULT,
  rightWidth: RIGHT_DEFAULT,
  onboardingDone: false,
  ...DEFAULT_LOOK,
  sounds: 'off',
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T =>
  typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : fallback;

/** Read and validate stored prefs; anything unknown or out of range falls back to the default. */
export function readPrefs(storage: Pick<Storage, 'getItem'> | null): Prefs {
  let raw: Record<string, unknown> = {};
  try {
    const text = storage?.getItem(PREFS_KEY);
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  return {
    theme: oneOf(raw.theme, ['system', 'light', 'dark'] as const, DEFAULT_PREFS.theme),
    textSize: oneOf(raw.textSize, ['s', 'm', 'l'] as const, DEFAULT_PREFS.textSize),
    section: oneOf(raw.section, ['chats', 'materials', 'wiki', 'graph', 'notifications'] as const, DEFAULT_PREFS.section),
    sideOpen: typeof raw.sideOpen === 'boolean' ? raw.sideOpen : DEFAULT_PREFS.sideOpen,
    sideWidth: clamp(raw.sideWidth, SIDE_MIN, SIDE_MAX, SIDE_DEFAULT),
    rightWidth: clamp(raw.rightWidth, RIGHT_MIN, RIGHT_MAX, RIGHT_DEFAULT),
    onboardingDone: raw.onboardingDone === true,
    base: oneOf(raw.base, BASES.map((o) => o.value), DEFAULT_PREFS.base),
    accent: oneOf(raw.accent, ACCENTS.map((o) => o.value), DEFAULT_PREFS.accent),
    density: oneOf(raw.density, DENSITIES.map((o) => o.value), DEFAULT_PREFS.density),
    motion: oneOf(raw.motion, MOTIONS.map((o) => o.value), DEFAULT_PREFS.motion),
    sounds: oneOf(raw.sounds, SOUNDS.map((o) => o.value), DEFAULT_PREFS.sounds),
  };
}

export interface PrefsActions {
  set: (patch: Partial<Prefs>) => void;
  setSideWidth: (px: number) => void;
  setRightWidth: (px: number) => void;
}

export type PrefsStore = StoreApi<Prefs & PrefsActions>;

export function createPrefsStore(storage: Storage | null): PrefsStore {
  const store = createStore<Prefs & PrefsActions>()((set) => ({
    ...readPrefs(storage),
    set: (patch) => set(patch),
    setSideWidth: (px) => set({ sideWidth: clamp(px, SIDE_MIN, SIDE_MAX, SIDE_DEFAULT) }),
    setRightWidth: (px) => set({ rightWidth: clamp(px, RIGHT_MIN, RIGHT_MAX, RIGHT_DEFAULT) }),
  }));
  store.subscribe((state) => {
    const data: Prefs = {
      theme: state.theme, textSize: state.textSize, section: state.section, sideOpen: state.sideOpen,
      sideWidth: state.sideWidth, rightWidth: state.rightWidth,
      onboardingDone: state.onboardingDone,
      base: state.base, accent: state.accent, density: state.density, motion: state.motion, sounds: state.sounds,
    };
    try { storage?.setItem(PREFS_KEY, JSON.stringify(data)); } catch { /* full or unavailable: keep in memory */ }
  });
  return store;
}
