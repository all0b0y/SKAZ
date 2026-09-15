import { describe, expect, it } from 'vitest';
import { highlightCitedText, type HastNode } from './citationHighlight';

const paragraph = (text: string): HastNode => ({
  type: 'element',
  tagName: 'p',
  children: [{ type: 'text', value: text }],
});

const citation = (text: string) => ({ segment_id: 's1', start_ms: 0, end_ms: 1_000, text });

describe('highlightCitedText', () => {
  it('wraps a citation quote found verbatim inside a text leaf in <mark>', () => {
    const tree = { type: 'root', children: [paragraph('Before, the quarterly revenue grew sharply, after.')] };
    highlightCitedText([citation('the quarterly revenue grew sharply')])(tree);

    const children = (tree.children[0] as { children: HastNode[] }).children;
    expect(children).toHaveLength(3);
    expect(children[0]).toMatchObject({ type: 'text', value: 'Before, ' });
    expect(children[1]).toMatchObject({
      type: 'element', tagName: 'mark', properties: { className: ['notes__cited'] },
    });
    expect((children[1] as { children: HastNode[] }).children[0]).toMatchObject({
      type: 'text', value: 'the quarterly revenue grew sharply',
    });
    expect(children[2]).toMatchObject({ type: 'text', value: ', after.' });
  });

  it('wraps the whole text leaf when it is contained inside a longer citation', () => {
    const tree = { type: 'root', children: [paragraph('short quoted span')] };
    highlightCitedText([citation('A much longer citation containing the short quoted span verbatim.')])(tree);

    const children = (tree.children[0] as { children: HastNode[] }).children;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ type: 'element', tagName: 'mark' });
  });

  it('leaves text untouched when there is no matching citation', () => {
    const tree = { type: 'root', children: [paragraph('Nothing here relates to any citation.')] };
    highlightCitedText([citation('Completely unrelated quote about the weather forecast.')])(tree);

    const children = (tree.children[0] as { children: HastNode[] }).children;
    expect(children).toEqual([{ type: 'text', value: 'Nothing here relates to any citation.' }]);
  });

  it('ignores citations shorter than the minimum trustworthy quote length', () => {
    const tree = { type: 'root', children: [paragraph('The budget is due soon.')] };
    highlightCitedText([citation('budget')])(tree);

    const children = (tree.children[0] as { children: HastNode[] }).children;
    expect(children).toEqual([{ type: 'text', value: 'The budget is due soon.' }]);
  });

  it('does not rewrite text inside code, pre, or link subtrees', () => {
    const codeNode: HastNode = {
      type: 'element', tagName: 'code',
      children: [{ type: 'text', value: 'the quarterly revenue grew sharply' }],
    };
    const tree = { type: 'root', children: [codeNode] };
    highlightCitedText([citation('the quarterly revenue grew sharply')])(tree);

    expect((codeNode as { children: HastNode[] }).children).toEqual([
      { type: 'text', value: 'the quarterly revenue grew sharply' },
    ]);
  });

  it('recurses into nested elements to find and wrap matching text', () => {
    const tree = {
      type: 'root',
      children: [{
        type: 'element', tagName: 'li',
        children: [paragraph('Nested: the quarterly revenue grew sharply here.')],
      }],
    };
    highlightCitedText([citation('the quarterly revenue grew sharply')])(tree);

    const li = tree.children[0] as { children: HastNode[] };
    const p = li.children[0] as { children: HastNode[] };
    expect(p.children.some((node) => 'tagName' in node && (node as { tagName?: string }).tagName === 'mark')).toBe(true);
  });
});
