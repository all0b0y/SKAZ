// G1 (SKAZ 0.4.1, 09-HEADING-ACCENTS.md): the decorative marks of heading accents — `@` for the open
// Material/Wiki title, `//` for a chat answer's main headings, one star for the Notes title and the
// main Wiki/Notes sections. The contract under test is the one the accepted decisions demand: the
// marker is ink, never text. Accessible names, quotes (`Selection.tsx` reads `selection.toString()`),
// the chat item picker (`chat/select/items.ts` walks text nodes), clipboard and Markdown export
// (`exportItems.tsx` writes from the source, never the DOM) must keep exactly the heading's own text.
// The app has no real-ASR/native claim here: this is DOM truth in jsdom; the glyph's painted look is
// for the wiring round's visual pass.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  documentTitleMark, headingLineClass, HeadingMark, type HeadingMarkKind,
} from './headingAccents';

afterEach(() => cleanup());

const css = () => readFileSync(resolve(__dirname, 'headingAccents.css'), 'utf8');

/** Every text node under `root`, the way `chat/select/items.ts` reads what a user sees. */
function textNodes(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node.textContent ?? '');
  return out;
}

describe('HeadingMark renders ink, not text', () => {
  for (const kind of ['at', 'slashes', 'star'] as const) {
    it(`${kind}: the mark carries no text node at all`, () => {
      const { container } = render(<HeadingMark kind={kind} />);
      const mark = container.querySelector<HTMLElement>('.kb-ham')!;
      expect(mark.getAttribute('data-ham')).toBe(kind);
      expect(mark.textContent).toBe('');
      expect(textNodes(mark)).toEqual([]);
      expect(mark.innerHTML).toContain('<svg');
    });

    it(`${kind}: is decoration — hidden from the a11y tree, out of the accessible name`, () => {
      render(
        <h2 className={headingLineClass}>
          <HeadingMark kind={kind} />
          <span>Atomicity and rollback</span>
        </h2>,
      );
      const heading = screen.getByRole('heading', { level: 2, name: 'Atomicity and rollback' });
      expect(heading.querySelector('.kb-ham')!.getAttribute('aria-hidden')).toBe('true');
      // The title stays the only text: quotes and clipboard copies of the line keep it clean.
      expect(textNodes(heading)).toEqual(['Atomicity and rollback']);
    });
  }

  it('each kind is its own drawing, so a wiring cannot silently show the wrong sign', () => {
    const pathsOf = (kind: HeadingMarkKind) => {
      const { container } = render(<HeadingMark kind={kind} />);
      const svg = container.querySelector('svg')!;
      return svg.innerHTML;
    };
    const at = pathsOf('at'), slashes = pathsOf('slashes'), star = pathsOf('star');
    expect(at).toContain('<circle');
    expect(at).not.toBe(slashes);
    expect(slashes).not.toBe(star);
    // The star is the six-stroke asterisk of the approved mock, drawn 1.5-wide like the app's icons.
    expect(star).toContain('M8 2v12');
    // `//` is two slanted strokes, each its own subpath — and no mark offers text through
    // alt/title/aria-label either.
    expect(slashes.match(/M[\d.]/g)?.length).toBe(2);
    for (const kind of ['at', 'slashes', 'star'] as const) {
      const { container } = render(<HeadingMark kind={kind} />);
      const mark = container.querySelector('.kb-ham')!;
      expect(mark.getAttribute('aria-label')).toBeNull();
      expect(mark.getAttribute('title')).toBeNull();
      expect(mark.querySelector('[aria-label], [title]')).toBeNull();
    }
  });

  it('the open document title takes the larger mark, sections and chat stay inline', () => {
    const { container, rerender } = render(<HeadingMark kind="star" />);
    expect(container.querySelector('.kb-ham')!.className).not.toContain('kb-ham--title');
    rerender(<HeadingMark kind="star" size="title" />);
    expect(container.querySelector('.kb-ham')!.className).toContain('kb-ham--title');
  });

  it('a host class lands on the span, nothing else changes', () => {
    const { container } = render(<HeadingMark kind="star" className="kb-psec__mark" />);
    const mark = container.querySelector('.kb-ham')!;
    expect(mark.className).toContain('kb-psec__mark');
    expect(mark.tagName).toBe('SPAN');
  });
});

describe('documentTitleMark — which sign an open document takes', () => {
  it('materials and wiki pages (concepts, analyses, folders, decks, tests) take `@`', () => {
    expect(documentTitleMark('material')).toBe('at');
    expect(documentTitleMark('concept')).toBe('at');
    expect(documentTitleMark('analysis')).toBe('at');
    expect(documentTitleMark('folder')).toBe('at');
    expect(documentTitleMark('deck')).toBe('at');
    expect(documentTitleMark('test')).toBe('at');
  });

  it('a Notes page keeps its single star', () => {
    expect(documentTitleMark('note')).toBe('star');
  });
});

describe('headingAccents.css stays scoped and on the existing accent', () => {
  it('paints with --kb-accent, never the fx accent, and adds no setting', () => {
    expect(css()).toContain('var(--kb-accent)');
    expect(css()).not.toContain('--kb-fx-accent');
    expect(css()).not.toMatch(/data-accent|--kb-accent\s*:/);
  });

  it('owns only kb-ham-prefixed classes: no shared selector can pick them up', () => {
    const rules = css().match(/^[^@/][^{]*\{/gm) ?? [];
    for (const rule of rules) expect(rule.trim()).toMatch(/\.kb-ham/);
  });

  it('carries no CSS text of its own — no pseudo-element could ever reach a selection', () => {
    // `content:` as a property (not the tail of `justify-content:`) would be the only way
    // this stylesheet could put letters into a selection.
    expect(css()).not.toMatch(/(^|[;{\s])content\s*:/);
  });

  it('baseline line layout for the host heading, the mark flexbox-fixed', () => {
    expect(css()).toMatch(/\.kb-ham-line\s*\{\s*display:\s*flex;/);
    expect(css()).toContain('align-items: baseline');
    expect(css()).toMatch(/\.kb-ham\s*\{[^}]*flex:\s*none/);
  });
});
