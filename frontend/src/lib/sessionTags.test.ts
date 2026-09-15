import { describe, expect, it } from 'vitest';
import { collectGroups, isUngrouped, parseTags, stripTags, tagColorIndex } from './sessionTags';

describe('parseTags', () => {
  it('extracts latin and cyrillic tags with digits/dash/underscore', () => {
    expect(parseTags('Матан #универ-2024_осн and #project1')).toEqual(['универ-2024_осн', 'project1']);
  });

  it('is case-insensitive but keeps the first-seen spelling', () => {
    expect(parseTags('#Универ meeting #универ recap')).toEqual(['Универ']);
  });

  it('dedupes repeated tags within one title', () => {
    expect(parseTags('#a note #a again #b')).toEqual(['a', 'b']);
  });

  it('returns an empty list for a title without tags', () => {
    expect(parseTags('Plain session name')).toEqual([]);
  });

  it('handles a title made only of tags', () => {
    expect(parseTags('#uni #project')).toEqual(['uni', 'project']);
  });
});

describe('stripTags', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripTags('Матан  #универ  для сдачи')).toBe('Матан для сдачи');
  });

  it('removes a trailing tag cleanly', () => {
    expect(stripTags('Standup notes #work')).toBe('Standup notes');
  });

  it('falls back to the original title when stripping leaves nothing', () => {
    expect(stripTags('#uni #project')).toBe('#uni #project');
  });

  it('is a no-op for a title without tags', () => {
    expect(stripTags('Plain session name')).toBe('Plain session name');
  });
});

describe('isUngrouped', () => {
  it('is true only when the title has no tags', () => {
    expect(isUngrouped({ title: 'Plain' })).toBe(true);
    expect(isUngrouped({ title: 'Plain #x' })).toBe(false);
  });
});

describe('tagColorIndex', () => {
  it('is deterministic and case-insensitive', () => {
    const a = tagColorIndex('Универ');
    const b = tagColorIndex('универ');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(5);
  });

  it('is stable across calls', () => {
    expect(tagColorIndex('project')).toBe(tagColorIndex('project'));
  });
});

describe('collectGroups', () => {
  it('counts sessions per group and sorts by count desc, then alphabetically', () => {
    const groups = collectGroups([
      { title: 'A #uni' },
      { title: 'B #work' },
      { title: 'C #uni #work' },
      { title: 'D #uni' },
      { title: 'E no tags' },
    ]);
    expect(groups).toEqual([
      { key: 'uni', label: 'uni', count: 3, colorIndex: tagColorIndex('uni') },
      { key: 'work', label: 'work', count: 2, colorIndex: tagColorIndex('work') },
    ]);
  });

  it('keeps a deterministic alphabetical order for equal counts', () => {
    const groups = collectGroups([{ title: 'A #zeta' }, { title: 'B #alpha' }]);
    expect(groups.map((g) => g.key)).toEqual(['alpha', 'zeta']);
  });

  it('uses the first-seen casing across sessions for the label', () => {
    const groups = collectGroups([{ title: 'A #Universität' }, { title: 'B #universität' }]);
    expect(groups).toEqual([
      { key: 'universität', label: 'Universität', count: 2, colorIndex: tagColorIndex('universität') },
    ]);
  });

  it('returns an empty list when no session has a tag', () => {
    expect(collectGroups([{ title: 'Plain' }])).toEqual([]);
  });
});
