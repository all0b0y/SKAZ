import { describe, expect, it } from 'vitest';
import { findChatMatches, moveChatMatch, retainChatMatch, type RenderedChatRun } from './findMatches';

describe('current chat matches', () => {
  const runs: RenderedChatRun[] = [
    { messageId: 'question', text: 'Как работает ' },
    { messageId: 'question', text: 'KV' },
    { messageId: 'question', text: '  Cache?' },
    { messageId: 'answer', text: 'KV Cache — КЭШ. Ёлка, е\u0308лка, елка. [code]+.' },
  ];

  it('maps a case-insensitive phrase through inline formatting in reading order', () => {
    const matches = findChatMatches(runs, '  kv cache  ');
    expect(matches.map(({ messageId, ranges }) => ({ messageId, ranges }))).toEqual([
      { messageId: 'question', ranges: [{ runIndex: 1, start: 0, end: 2 }, { runIndex: 2, start: 0, end: 7 }] },
      { messageId: 'answer', ranges: [{ runIndex: 3, start: 0, end: 8 }] },
    ]);
    expect(findChatMatches(runs, 'кэш')).toHaveLength(1);
    expect(findChatMatches(runs, '[code]+')).toHaveLength(1);
    expect(findChatMatches(runs, '?kv')).toEqual([]);
  });

  it('keeps diacritics and maps canonical spellings to original UTF-16 offsets', () => {
    const source: RenderedChatRun[] = [
      { messageId: 'a', text: '💡е' }, { messageId: 'a', text: '\u0308лка елка İКЭШ' },
    ];
    expect(findChatMatches(source, 'Ёлка')[0]?.ranges).toEqual([
      { runIndex: 0, start: 2, end: 3 }, { runIndex: 1, start: 0, end: 4 },
    ]);
    expect(findChatMatches(source, 'елка')).toHaveLength(1);
    expect(findChatMatches(source, 'кэш')[0]?.ranges).toEqual([{ runIndex: 1, start: 11, end: 14 }]);
  });

  it('keeps IDs across run splits, appended text and changes in other messages', () => {
    const before = findChatMatches(runs, 'cache');
    const active = moveChatMatch(retainChatMatch(before), 1);
    const after = findChatMatches([
      { messageId: 'older', text: 'Cache' }, ...runs.slice(0, 3),
      { messageId: 'answer', text: 'KV Ca' },
      { messageId: 'answer', text: 'che — КЭШ. Ёлка, е\u0308лка, елка. [code]+. Another cache.' },
    ], 'cache');
    expect(after.slice(1, 3).map((match) => match.id)).toEqual(before.map((match) => match.id));
    expect(retainChatMatch(after, active)).toMatchObject({ activeIndex: 2, activeMatch: { id: before[1]?.id } });
    expect(moveChatMatch(retainChatMatch(after), -1).activeIndex).toBe(3);
    expect(moveChatMatch(moveChatMatch(retainChatMatch(after), -1), 1).activeIndex).toBe(0);
    expect(retainChatMatch(after.slice(0, 1), active).activeIndex).toBe(0);
  });

  it('leaves separate blocks separate and handles empty or absent queries', () => {
    const split = [{ messageId: 'm', text: 'first' }, { messageId: 'm', text: 'line', breakBefore: true }];
    expect(findChatMatches(split, 'firstline')).toEqual([]);
    expect(findChatMatches(split, 'first line')).toEqual([]);
    expect(findChatMatches(split, ' \t ')).toEqual([]);
    const empty = retainChatMatch(findChatMatches(split, 'missing'));
    expect(moveChatMatch(empty, 1)).toEqual({ matches: [], activeIndex: -1, activeMatch: null });
  });
});
