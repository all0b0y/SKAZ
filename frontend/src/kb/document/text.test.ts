import { describe, expect, it } from 'vitest';
import { blockMarkdown, inAppTarget, readableBlockText } from './text';

const NOTE = 'Materials/B5/B5 · Heat engines/B5 · Heat engines';

describe('wiki block text (QA C1, C2, C11)', () => {
  it('page and material links become in-app links; citation links are left out', () => {
    const text = `Heat goes from hot to cold. [[${NOTE}#^seg-1|B5 · Heat engines · ¶ 1]] [[Wiki/Concepts/Carnot engine (машина Карно)|Carnot engine (машина Карно)]] ^c-link-1`;
    const md = blockMarkdown(text, [{ target: 'Wiki/Concepts/Carnot engine (машина Карно)', page: { id: 'pg-carnot', kind: 'concept', title: 'Carnot engine (машина Карно)' } }]);
    expect(md).toBe('Heat goes from hot to cold. [Carnot engine (машина Карно)](skaz-page:pg-carnot)');
    expect(inAppTarget('skaz-page:pg-carnot')).toEqual({ type: 'page', id: 'pg-carnot' });
    expect(inAppTarget('https://example.org')).toBeNull();
  });

  it('"In folders" keeps the material link after the folder name — no orphan colon', () => {
    const text = `B5: [[${NOTE}|B5 · Heat engines]], [[Materials/B5/Gone/Gone|Gone]] ^c-in-folders`;
    expect(blockMarkdown(text, [{ target: NOTE, material_id: 'mat-1' }, { target: 'Materials/B5/Gone/Gone', page: null, material_id: null }]))
      .toBe('B5: [B5 · Heat engines](skaz-material:mat-1), Gone');
    expect(readableBlockText(text)).toBe('B5: B5 · Heat engines, Gone');
  });

  it('an agent list "1. …; 2. …" in one paragraph keeps its first number', () => {
    expect(blockMarkdown('1. [[Wiki/Notes/A|A]]; 2. [[Wiki/Notes/B|B]]', [], true)).toBe('1\\. A; 2. B');
    expect(blockMarkdown('1. my own list', [], false)).toBe('1. my own list');
  });

  it('a bracket in a label stays inside the link text', () => {
    expect(blockMarkdown('[[Wiki/Concepts/X|a [b c]]', [{ target: 'Wiki/Concepts/X', page: { id: 'x', kind: 'concept', title: 'X' } }]))
      .toBe('[a \\[b c](skaz-page:x)');
  });
});
