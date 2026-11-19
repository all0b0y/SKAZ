// G1 audit regressions: only populated, document-level reply headings get the decorative mark.
// These synthetic DOM fixtures use the production Markdown, quote and chat-find implementations.
import { describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { InlineMarkdown } from '../../chat/Markdown';
import { MarkdownView } from '../../ui/markdown/Markdown';
import { quoteAttrs, readSelectionQuote } from '../../ui/Selection';
import { collectRenderedChatRuns } from '../../chat/findInChat041/renderedChat';
import { findChatMatches } from '../../chat/findInChat041/findMatches';
import { headingLineClass } from './headingAccents';

const noSlot = () => null;

describe('G1 audit finding 1: incomplete main headings', () => {
  it.each(['', '#', '# ', '#\t', '# ##', '# ##  ', '# \t ### \t', '# <!-- draft -->', '# [](https://example.invalid)'])(
    '%j has neither a stand-alone mark nor an empty answer heading',
    (source) => {
      const { container } = render(<InlineMarkdown pieces={[source]} slot={noSlot} />);
      expect(container.querySelector('[data-ham]')).toBeNull();
      expect(container.querySelector(`.${headingLineClass}`)).toBeNull();
      expect(container.querySelector('h3')).toBeNull();
      expect(container.textContent).toBe('');
    },
  );

  it.each([
    '# ![](https://example.invalid/diagram.png)',
    '[![](https://example.invalid/diagram.png)](https://example.invalid)\n===',
    '# ` `',
    '# \\( \\)',
  ])('%j does not create a heading from inline content that renders empty', (source) => {
    const { container } = render(<InlineMarkdown pieces={[source]} slot={noSlot} />);
    expect(container.querySelector('h3, [data-ham]')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it.each([
    ['# ![Diagram](https://example.invalid/diagram.png)', 'Diagram'],
    ['# `Query`', 'Query'],
  ])('%j still decorates the visible inline heading text', (source, name) => {
    const { container } = render(<InlineMarkdown pieces={[source]} slot={noSlot} />);
    const title = within(container).getByRole('heading', { level: 3, name });
    expect(title.querySelectorAll('[data-ham="slashes"]')).toHaveLength(1);
    expect(title.textContent?.trim()).toBe(name);
  });

  it('reconciles a streamed opener → populated → empty → populated heading without stray decoration', () => {
    const { container, rerender } = render(<InlineMarkdown pieces={['#']} slot={noSlot} />);
    expect(container.querySelector('[data-ham]')).toBeNull();
    expect(container.querySelector('h3')).toBeNull();

    for (const source of ['# W', '# Words *arrive*']) {
      rerender(<InlineMarkdown pieces={[source]} slot={noSlot} />);
      const title = within(container).getByRole('heading', {
        level: 3, name: source === '# W' ? 'W' : 'Words arrive',
      });
      expect(title.querySelectorAll('[data-ham="slashes"]')).toHaveLength(1);
      expect(title).toHaveClass(headingLineClass);
    }

    rerender(<InlineMarkdown pieces={['# ##']} slot={noSlot} />);
    expect(container.querySelector('[data-ham]')).toBeNull();
    expect(container.querySelector('h3')).toBeNull();
    rerender(<InlineMarkdown pieces={['# Words arrive']} slot={noSlot} />);
    expect(within(container).getByRole('heading', { name: 'Words arrive' })
      .querySelectorAll('[data-ham="slashes"]')).toHaveLength(1);
  });

  it('resolves heading content once, keeping each inline source slot at its original position', () => {
    const slot = vi.fn((index: number, key: string) => <span key={key} data-source={index}>[source]</span>);
    const { container } = render(<InlineMarkdown pieces={['# **Title**', 0, ' words']} slot={slot} />);
    const title = within(container).getByRole('heading', { name: 'Title[source] words' });
    expect(slot).toHaveBeenCalledTimes(1);
    expect(title.querySelector('strong')?.nextSibling).toBe(title.querySelector('[data-source="0"]'));
    expect(title.querySelectorAll('[data-source]')).toHaveLength(1);
    expect(title.querySelectorAll('[data-ham="slashes"]')).toHaveLength(1);
  });

  it('keeps a source chip after a bare opener without turning it into a main heading', () => {
    const slot = vi.fn((index: number, key: string) => <span key={key}>[source {index}]</span>);
    const { container, rerender } = render(<InlineMarkdown pieces={['# ', 0]} slot={slot} />);
    expect(slot).toHaveBeenCalledTimes(1);
    expect(within(container).getByText('[source 0]')).toBeInTheDocument();
    expect(container.querySelector('h3, [data-ham]')).toBeNull();

    rerender(<InlineMarkdown pieces={['# ', 0]} slot={noSlot} />);
    expect(container.querySelector('h3, [data-ham]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('G1 audit finding 2: main versus quote/list-local headings', () => {
  const mixed = [
    '# Main *title*',
    '> # Quoted title',
    '- # Bullet title',
    '1. # Ordered title',
    '> - # Quoted list title',
    '- > # List quote title',
    'Setext main\n===========',
    '> Setext quote\n> ============',
    '- Setext list\n  ===========',
    '## Smaller title',
  ].join('\n\n');

  it('decorates top-level ATX and Setext titles only, even alongside headings in nested containers', () => {
    const { container } = render(<InlineMarkdown pieces={[mixed]} slot={noSlot} />);
    const main = within(container).getByRole('heading', { name: 'Main title' });
    const setext = within(container).getByRole('heading', { name: 'Setext main' });
    expect(container.querySelectorAll('[data-ham="slashes"]')).toHaveLength(2);
    for (const title of [main, setext]) {
      expect(title).toHaveClass(headingLineClass);
      expect(title.querySelectorAll('[data-ham="slashes"]')).toHaveLength(1);
    }
    const nested = [...container.querySelectorAll('blockquote h3, li h3')];
    expect(nested).toHaveLength(7);
    for (const title of nested) {
      expect(title.querySelector('[data-ham]')).toBeNull();
      expect(title).not.toHaveClass(headingLineClass);
    }
    expect(within(container).getByRole('heading', { name: 'Smaller title' }).querySelector('[data-ham]')).toBeNull();
  });

  it.each(['> # Quoted only', '- # Bullet only', '1. # Ordered only'])(
    'does not promote %j when the reply has no main heading',
    (source) => {
      const { container } = render(<InlineMarkdown pieces={[source]} slot={noSlot} />);
      expect(container.querySelector('h3')).not.toBeNull();
      expect(container.querySelector('[data-ham]')).toBeNull();
      expect(container.querySelector(`.${headingLineClass}`)).toBeNull();
    },
  );

  it('keeps selection quotes and find ranges as words, excluding the decorative sign and link destinations', () => {
    const source = '# Main *title*\n\n> # Quoted title\n\n- # Bullet title\n\n# [Linked title](https://example.invalid/hidden)';
    const { container } = render(
      <article className="kb-msg--assistant" data-message-id="synthetic-answer">
        <div className="kb-msg__body" {...quoteAttrs({ source: 'chat', id: 'synthetic-chat', message_id: 'synthetic-answer' })}>
          <InlineMarkdown pieces={[source]} slot={noSlot} />
        </div>
      </article>,
    );
    const selection = window.getSelection()!;
    try {
      for (const name of ['Main title', 'Quoted title', 'Bullet title', 'Linked title']) {
        const title = within(container).getByRole('heading', { name });
        const range = document.createRange();
        range.selectNodeContents(title);
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe(name);
        expect(readSelectionQuote(selection)).toMatchObject({
          source: 'chat', id: 'synthetic-chat', message_id: 'synthetic-answer', text: name,
        });
        const runs = collectRenderedChatRuns(container);
        const matches = findChatMatches(runs, name);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.ranges.map(({ runIndex, start, end }) =>
          runs[runIndex]!.text.slice(start, end)).join('')).toBe(name);
      }
      const runs = collectRenderedChatRuns(container);
      expect(findChatMatches(runs, '//')).toHaveLength(0);
      expect(findChatMatches(runs, 'hidden')).toHaveLength(0);
    } finally {
      selection.removeAllRanges();
    }
  });

  it('leaves non-answer Markdown markup unchanged: opt-in is still required', () => {
    const { container } = render(<MarkdownView pieces={[mixed, '\n\n#']} className="md" />);
    expect(container.querySelectorAll('h3')).toHaveLength(10);
    expect(container.querySelectorAll('blockquote h3, li h3')).toHaveLength(7);
    expect(container.querySelector('[data-ham]')).toBeNull();
    expect(container.querySelector(`.${headingLineClass}`)).toBeNull();
    expect(within(container).getByRole('heading', { name: 'Main title' })).toBeInTheDocument();
  });

  it('uses deterministic counts for repeated local fixtures, with one mark per real main heading', () => {
    const count = 64;
    const source = Array.from({ length: count }, (_, i) => [
      `# Main ${i}`, `> # Quote ${i}`, `- # List ${i}`, '# ##',
    ].join('\n\n')).join('\n\n');
    const { container } = render(<InlineMarkdown pieces={[source]} slot={noSlot} />);
    expect(container.querySelectorAll('h3')).toHaveLength(count * 3);
    expect(container.querySelectorAll('[data-ham="slashes"]')).toHaveLength(count);
    expect(container.querySelectorAll('blockquote [data-ham], li [data-ham]')).toHaveLength(0);
  });
});
