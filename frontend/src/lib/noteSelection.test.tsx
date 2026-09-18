import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markSourceOffsets } from './sourceOffsets';
import { blockRangeOf, resolveSelectionSpan } from './noteSelection';

/**
 * A selection made on screen must name a span of the STORED Markdown.
 *
 * The two differ wherever markup was consumed, so a rewrite that trusted the
 * rendered offsets would replace the wrong characters — shifting the passage by
 * as many characters as there are asterisks before it.
 */

const renderNote = (source: string) => render(
  <div className="note-editor__preview">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[markSourceOffsets]}>
      {source}
    </ReactMarkdown>
  </div>,
);

describe('source offsets of a rendered note', () => {
  it('maps a selection inside emphasis back to the raw span, markup included', () => {
    const source = '# Заголовок\n\nЭто **важный** пункт.';
    renderNote(source);
    const paragraph = screen.getByText(/пункт/).closest('p')!;
    const block = blockRangeOf(paragraph, null);
    expect(block).toEqual({ start: source.indexOf('Это'), end: source.length });

    const span = resolveSelectionSpan(source, 'важный', block);
    // The rendered text has "Это важный пункт." but the file has the asterisks:
    // the span must point past them, at the word itself.
    expect(source.slice(span!.start, span!.end)).toBe('важный');
    expect(span!.start).toBe(source.indexOf('важный'));
  });

  it('resolves the copy that was selected when a phrase repeats', () => {
    const source = '- Экзамен в пятницу\n- Другое про экзамен\n- Экзамен в пятницу';
    renderNote(source);
    const items = screen.getAllByText('Экзамен в пятницу');
    const second = blockRangeOf(items[1]?.closest('li') ?? null, null);

    const span = resolveSelectionSpan(source, 'Экзамен в пятницу', second);
    // Without the block the text alone is ambiguous and must not be guessed.
    expect(resolveSelectionSpan(source, 'Экзамен в пятницу', null)).toBeNull();
    expect(span!.start).toBe(source.lastIndexOf('Экзамен в пятницу'));
  });

  it('reports nothing for text that is not in the document', () => {
    const source = 'Определение термина.';
    renderNote(source);
    expect(resolveSelectionSpan(source, 'то, чего здесь нет', null)).toBeNull();
    expect(resolveSelectionSpan(source, '   ', null)).toBeNull();
  });

  it('has no range for an element outside the rendered note', () => {
    render(<div data-testid="elsewhere">Текст из другого места окна</div>);
    expect(blockRangeOf(screen.getByTestId('elsewhere'), null)).toBeNull();
  });

  it('annotates headings and list items, not inline elements', () => {
    const source = '# Заголовок\n\n- Пункт с **выделением**';
    const { container } = renderNote(source);
    expect(container.querySelector('h1')).toHaveAttribute('data-md-start', '0');
    expect(container.querySelector('li')).toHaveAttribute('data-md-start');
    // An inline span would multiply attributes for no gain.
    expect(container.querySelector('strong')).not.toHaveAttribute('data-md-start');
  });
});
