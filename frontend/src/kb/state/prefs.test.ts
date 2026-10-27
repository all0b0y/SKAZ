import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, PREFS_KEY, WIKI_OPEN_DEFAULT, createPrefsStore, readPrefs } from './prefs';

describe('Renderer prefs of the new interface', () => {
  it('falls back to defaults for anything missing, unknown or out of range', () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    const store = { getItem: () => JSON.stringify({ theme: 'neon', sideWidth: 9999, rightWidth: 10, section: 'graph', languages: ['ru'], translateTo: 'ru' }) };
    // Languages and translation live in the backend's speech settings (QA A11), not in renderer prefs.
    expect(readPrefs(store)).toEqual({ ...DEFAULT_PREFS, sideWidth: 360, rightWidth: 320, section: 'graph' });
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

  it('wiki kind sections: Concepts open, the rest folded by default; each stored fold is validated on its own', () => {
    expect(DEFAULT_PREFS.wikiOpen).toEqual({ concept: true, note: false, analysis: false, folder: false, deck: false, test: false });
    const read = (wikiOpen: unknown) => readPrefs({ getItem: () => JSON.stringify({ wikiOpen }) }).wikiOpen;
    expect(read({ concept: false, note: true, deck: 'yes', bogus: true })).toEqual({ ...WIKI_OPEN_DEFAULT, concept: false, note: true });
    expect(read(['concept'])).toEqual(WIKI_OPEN_DEFAULT);
    expect(read(null)).toEqual(WIKI_OPEN_DEFAULT);
  });

  it('a fold choice is kept across restarts', () => {
    localStorage.clear();
    const store = createPrefsStore(localStorage);
    store.getState().setWikiOpen('analysis', true);
    store.getState().setWikiOpen('concept', false);
    expect(createPrefsStore(localStorage).getState().wikiOpen).toEqual({ ...WIKI_OPEN_DEFAULT, analysis: true, concept: false });
  });
});
