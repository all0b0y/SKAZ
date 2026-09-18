import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteList, NOTES_PER_PAGE } from './NoteList';
import type { Note } from '../../api/types';

/**
 * Paging the session's note list.
 *
 * A lecture course accumulates notes, and a list that simply grows pushes the two
 * start buttons off the pane. Five rows at a time keeps the page a fixed height,
 * so the controls below it never move.
 */

const note = (n: number): Note => ({
  id: `n${n}`,
  revision: 1,
  content: '',
  title: `Конспект ${n}`,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
});

const many = (count: number) => Array.from({ length: count }, (_, i) => note(i + 1));

const renderList = (notes: Note[]) => {
  const onOpen = vi.fn();
  render(<NoteList notes={notes} onOpen={onOpen} onRename={vi.fn()} onDelete={vi.fn()} />);
  return { onOpen };
};

const rowTitles = () => within(screen.getByRole('list', { name: 'Конспекты сессии' }))
  .getAllByRole('listitem')
  .map((row) => row.textContent ?? '');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('note list paging', () => {
  it('shows five notes per page and no pager when they all fit', () => {
    renderList(many(NOTES_PER_PAGE));
    expect(rowTitles()).toHaveLength(NOTES_PER_PAGE);
    // A single page has nothing to page through; the controls would be dead weight.
    expect(screen.queryByRole('navigation', { name: 'Страницы конспектов' })).not.toBeInTheDocument();
  });

  it('splits a longer list into pages and moves between them', async () => {
    const user = userEvent.setup();
    renderList(many(12));

    expect(rowTitles()).toHaveLength(NOTES_PER_PAGE);
    expect(rowTitles()[0]).toContain('Конспект 1');
    const pager = screen.getByRole('navigation', { name: 'Страницы конспектов' });
    expect(pager).toHaveTextContent('1 из 3');
    // Nowhere to go back from the first page.
    expect(within(pager).getByRole('button', { name: 'Предыдущая страница' })).toBeDisabled();

    await user.click(within(pager).getByRole('button', { name: 'Следующая страница' }));
    expect(rowTitles()[0]).toContain('Конспект 6');
    expect(screen.getByRole('navigation', { name: 'Страницы конспектов' })).toHaveTextContent('2 из 3');

    await user.click(screen.getByRole('button', { name: 'Следующая страница' }));
    // The last page is the remainder, not a padded five.
    expect(rowTitles()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Предыдущая страница' }));
    expect(rowTitles()[0]).toContain('Конспект 6');
  });

  it('pulls the last page back when its notes are deleted away', () => {
    const { rerender } = render(
      <NoteList notes={many(6)} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />,
    );
    // Deleting the sixth note leaves one full page; staying on page 2 would show
    // an empty list with no indication of why.
    rerender(<NoteList notes={many(5)} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
    expect(rowTitles()).toHaveLength(5);
    expect(screen.queryByRole('navigation', { name: 'Страницы конспектов' })).not.toBeInTheDocument();
  });

  it('opens the note that was clicked on a later page, not its neighbour', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderList(many(7));
    await user.click(screen.getByRole('button', { name: 'Следующая страница' }));
    await user.click(screen.getByRole('button', { name: 'Открыть Конспект 7' }));
    // The open is deferred to let a double click cancel it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ id: 'n7' });
  });
});
