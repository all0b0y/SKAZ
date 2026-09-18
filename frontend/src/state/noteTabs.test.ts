import { describe, expect, it } from 'vitest';
import {
  activeTab,
  attachNote,
  closeTab,
  emptyTabs,
  loadTabs,
  openTab,
  pruneTabs,
  renameTab,
  saveTabs,
  selectTab,
  titleFromContent,
  type TabsState,
} from './noteTabs';

const open = (state: TabsState, sessionId: string, noteId: string | null, title = 'Note') =>
  openTab(state, { sessionId, noteId, title });

describe('note tabs', () => {
  it('opens a tab and focuses it', () => {
    const state = open(emptyTabs, 's1', 'n1');
    expect(state.tabs).toHaveLength(1);
    expect(activeTab(state)?.noteId).toBe('n1');
  });

  it('focuses an already open note instead of duplicating it', () => {
    const first = open(emptyTabs, 's1', 'n1');
    const second = open(open(first, 's1', 'n2'), 's1', 'n1');
    expect(second.tabs).toHaveLength(2);
    expect(activeTab(second)?.noteId).toBe('n1');
  });

  it('keeps empty tabs separate even though they have no note yet', () => {
    const state = open(open(emptyTabs, 's1', null), 's1', null);
    expect(state.tabs).toHaveLength(2);
  });

  it('pins each tab to its own session', () => {
    const state = open(open(emptyTabs, 's1', 'n1'), 's2', 'n9');
    // The same note id in another session is a different document.
    const third = open(state, 's2', 'n1');
    expect(third.tabs.map((tab) => tab.sessionId)).toEqual(['s1', 's2', 's2']);
  });

  it('focuses the neighbour when the active tab is closed', () => {
    const state = open(open(open(emptyTabs, 's1', 'n1'), 's1', 'n2'), 's1', 'n3');
    const closed = closeTab(state, state.tabs[2]!.id);
    expect(activeTab(closed)?.noteId).toBe('n2');
  });

  it('leaves the focus alone when another tab is closed', () => {
    const state = open(open(emptyTabs, 's1', 'n1'), 's1', 'n2');
    const closed = closeTab(state, state.tabs[0]!.id);
    expect(activeTab(closed)?.noteId).toBe('n2');
  });

  it('reports no active tab once the last one is closed', () => {
    const state = open(emptyTabs, 's1', 'n1');
    const closed = closeTab(state, state.tabs[0]!.id);
    expect(closed.tabs).toEqual([]);
    expect(closed.activeTabId).toBeNull();
  });

  it('binds an empty tab to the note it becomes on first save', () => {
    const state = open(emptyTabs, 's1', null);
    const bound = attachNote(state, state.tabs[0]!.id, 'n5');
    expect(bound.tabs[0]!.noteId).toBe('n5');
    // A second save must not open another tab for the same document.
    expect(open(bound, 's1', 'n5').tabs).toHaveLength(1);
  });

  it('renames a tab without touching the others', () => {
    const state = open(open(emptyTabs, 's1', 'n1', 'A'), 's1', 'n2', 'B');
    const renamed = renameTab(state, state.tabs[0]!.id, 'Новый заголовок');
    expect(renamed.tabs.map((tab) => tab.title)).toEqual(['Новый заголовок', 'B']);
  });

  it('drops tabs whose note no longer exists', () => {
    const state = open(open(emptyTabs, 's1', 'n1'), 's1', 'n2');
    const pruned = pruneTabs(state, (tab) => tab.noteId !== 'n2');
    expect(pruned.tabs.map((tab) => tab.noteId)).toEqual(['n1']);
    expect(activeTab(pruned)?.noteId).toBe('n1');
  });

  it('ignores selecting a tab that is not open', () => {
    const state = open(emptyTabs, 's1', 'n1');
    expect(selectTab(state, 'nonexistent')).toBe(state);
  });

  it('names a tab after the first heading of its content', () => {
    expect(titleFromContent('## Раздел про графы\n- пункт')).toBe('Раздел про графы');
    expect(titleFromContent('\n\nПервая строка без заголовка')).toBe('Первая строка без заголовка');
    expect(titleFromContent('   \n')).toBe('');
  });
});

describe('note tabs persistence', () => {
  const memory = (): Storage => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    } as unknown as Storage;
  };

  it('survives a restart', () => {
    const storage = memory();
    const state = open(open(emptyTabs, 's1', 'n1', 'Лекция'), 's2', 'n2', 'Встреча');
    saveTabs(state, storage);
    const restored = loadTabs(storage);
    expect(restored.tabs.map((tab) => [tab.sessionId, tab.noteId, tab.title])).toEqual([
      ['s1', 'n1', 'Лекция'],
      ['s2', 'n2', 'Встреча'],
    ]);
    expect(activeTab(restored)?.noteId).toBe('n2');
  });

  it('returns no tabs rather than throwing on corrupt storage', () => {
    const storage = memory();
    storage.setItem('audiohelper.noteTabs', '{not json');
    expect(loadTabs(storage)).toEqual(emptyTabs);
  });

  it('drops malformed entries instead of rendering a tab that points nowhere', () => {
    const storage = memory();
    storage.setItem('audiohelper.noteTabs', JSON.stringify({
      tabs: [{ id: 't1', sessionId: 's1', noteId: 'n1', title: 'Ok' }, { id: 't2' }, null, 'x'],
      activeTabId: 't2',
    }));
    const restored = loadTabs(storage);
    expect(restored.tabs).toHaveLength(1);
    expect(restored.activeTabId).toBe('t1');
  });

  it('never persists note text, only the reference', () => {
    const storage = memory();
    saveTabs(open(emptyTabs, 's1', 'n1', 'Заголовок'), storage);
    expect(storage.getItem('audiohelper.noteTabs')).not.toContain('content');
  });
});
