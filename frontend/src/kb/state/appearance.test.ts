import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, PRESETS, presetLook, presetOf } from './appearance';
import { DEFAULT_PREFS, PREFS_KEY, createPrefsStore, readPrefs } from './prefs';

describe('appearance presets', () => {
  it('the default look is the SKAZ preset', () => {
    expect(presetOf(DEFAULT_LOOK)).toBe('skaz');
    expect(presetOf({ base: DEFAULT_PREFS.base, accent: DEFAULT_PREFS.accent, density: DEFAULT_PREFS.density })).toBe('skaz');
  });

  it('recognises every preset and turns into custom when one knob moves', () => {
    for (const p of PRESETS) expect(presetOf(presetLook(p.id))).toBe(p.id);
    expect(presetOf({ ...presetLook('lecture'), density: 'compact' })).toBe('custom');
  });

  it('presets are distinct combinations', () => {
    const keys = PRESETS.map((p) => JSON.stringify(p.look));
    expect(new Set(keys).size).toBe(PRESETS.length);
  });
});

describe('appearance prefs', () => {
  it('reads, validates and persists the knobs', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } as unknown as Storage;
    data.set(PREFS_KEY, JSON.stringify({ base: 'sand', accent: 'nope', density: 'spacious', motion: 'off', sounds: 'subtle' }));
    expect(readPrefs(storage)).toMatchObject({ base: 'sand', accent: 'ink', density: 'spacious', motion: 'off', sounds: 'subtle' });
    const store = createPrefsStore(storage);
    store.getState().set({ ...presetLook('slate') });
    // Decision 32: a preset keeps the user's motion («off» stays «off»).
    expect(JSON.parse(data.get(PREFS_KEY)!)).toMatchObject({ base: 'slate', accent: 'slate', density: 'comfortable', motion: 'off', sounds: 'subtle' });
  });

  it('sounds are off by default', () => {
    expect(readPrefs(null).sounds).toBe('off');
  });
});
