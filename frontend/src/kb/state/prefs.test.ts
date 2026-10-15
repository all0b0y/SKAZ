import { describe, expect, it } from 'vitest';
import { chooseInterface } from '../uiChoice';
import { DEFAULT_PREFS, PREFS_KEY, createPrefsStore, readPrefs } from './prefs';

describe('Interface choice (main.tsx)', () => {
  it('starts the new interface only for an explicit "kb"', () => {
    expect(chooseInterface('kb', () => null)).toBe('kb');
    expect(chooseInterface(undefined, () => 'kb')).toBe('kb');
    expect(chooseInterface(undefined, () => null)).toBe('legacy');
    expect(chooseInterface('', () => 'KB')).toBe('legacy');
    expect(chooseInterface(undefined, () => { throw new Error('storage blocked'); })).toBe('legacy');
  });
});

describe('Renderer prefs of the new interface', () => {
  it('falls back to defaults for anything missing, unknown or out of range', () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    const store = { getItem: () => JSON.stringify({ theme: 'neon', sideWidth: 9999, rightWidth: 10, section: 'graph', languages: ['ru', 'EN', 7, 'de'], translateTo: '../x' }) };
    expect(readPrefs(store)).toMatchObject({ theme: 'system', sideWidth: 360, rightWidth: 320, section: 'graph', languages: ['ru', 'de'], translateTo: '' });
    expect(readPrefs({ getItem: () => '{not json' })).toEqual(DEFAULT_PREFS);
  });

  it('persists every change under one key', () => {
    localStorage.clear();
    const store = createPrefsStore(localStorage);
    store.getState().setSideWidth(300.4);
    store.getState().set({ theme: 'dark' });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ sideWidth: 300, theme: 'dark' });
    expect(createPrefsStore(localStorage).getState().sideWidth).toBe(300);
  });
});
