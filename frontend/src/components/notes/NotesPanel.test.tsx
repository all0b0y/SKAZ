import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Citation, Note } from '../../api/types';

const note = (overrides: Partial<Note> = {}): Note => ({
  content: 'Some notes content.',
  created_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [],
  ...overrides,
});

const seed = (notes: Note | null) => {
  useStore.setState({
    activeSessionId: 's1',
    detail: { segments: [{ id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' }], messages: [], notes },
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
  });
};

// jsdom's real Selection/Range implementation does not report layout or
// even string content reliably, so tests drive the same window.getSelection
// contract NotesPanel reads, anchored to a real node inside the rendered
// notes content (found via an accessible query) so containment checks pass.
const selectText = (text: string, containerNode: Node) => {
  const fakeSelection = {
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({
      commonAncestorContainer: containerNode,
      getBoundingClientRect: () => ({ top: 10, left: 20, bottom: 30, right: 100, width: 80, height: 20, x: 20, y: 10, toJSON: () => ({}) }),
    }),
  } as unknown as Selection;
  vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection);
  fireEvent.mouseUp(document);
};

const clearSelection = () => {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => '',
    rangeCount: 0,
    getRangeAt: () => { throw new Error('no range'); },
  } as unknown as Selection);
  fireEvent.mouseUp(document);
};

beforeEach(() => {
  seed(null);
});

describe('NotesPanel markdown rendering', () => {
  it('renders markdown as real markup instead of raw text', () => {
    seed(note({ content: '## Heading\n\n- one\n- two\n\n**bold** and *italic*.' }));
    render(<NotesPanel onCite={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    // The raw markdown syntax itself must not leak through as literal text.
    expect(screen.queryByText(/##\s*Heading/)).not.toBeInTheDocument();
  });

  it('never executes or renders raw HTML embedded in notes content', () => {
    seed(note({
      content: 'Before <script>window.__pwned = true;</script> after, and <img src="x" onerror="window.__pwned = true">.',
    }));
    render(<NotesPanel onCite={vi.fn()} />);

    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('renders a safe external link with target=_blank and rel=noopener noreferrer', () => {
    seed(note({ content: '[docs](https://example.com/docs)' }));
    render(<NotesPanel onCite={vi.fn()} />);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders an unsafe-scheme link as plain inert text, not a clickable anchor', () => {
    seed(note({ content: '[click me](javascript:alert(1))' }));
    render(<NotesPanel onCite={vi.fn()} />);

    expect(screen.queryByRole('link', { name: 'click me' })).not.toBeInTheDocument();
    expect(screen.getByText('click me')).toBeInTheDocument();
  });

  it('collapses the Sources footer into a compact <details> element', () => {
    const citation: Citation = { segment_id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'hi' };
    seed(note({ citations: [citation] }));
    render(<NotesPanel onCite={vi.fn()} />);

    const details = document.querySelector('details.notes__sources');
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText(/Sources \(1\)/)).toBeInTheDocument();
  });
});

describe('NotesPanel selection toolbar', () => {
  it('shows the "Open in transcript" action when the selection matches a citation', () => {
    const citation: Citation = { segment_id: 'seg-1', start_ms: 754_000, end_ms: 760_000, text: 'the quarterly revenue grew sharply' };
    seed(note({ content: 'Notes say the quarterly revenue grew sharply this year.', citations: [citation] }));
    const onCite = vi.fn();
    render(<NotesPanel onCite={onCite} />);

    const paragraph = document.querySelector('.notes__content p')!;
    selectText('the quarterly revenue grew sharply', paragraph);

    const toolbar = screen.getByRole('toolbar', { name: 'Selection actions' });
    const jumpButton = screen.getByRole('button', { name: /Open in transcript/ });
    expect(toolbar).toContainElement(jumpButton);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();

    fireEvent.click(jumpButton);
    expect(onCite).toHaveBeenCalledWith(citation);
  });

  it('does not show a jump-to-transcript action when no citation matches the selection', () => {
    const citation: Citation = { segment_id: 'seg-1', start_ms: 0, end_ms: 1_000, text: 'Completely unrelated citation about the weather.' };
    seed(note({ content: 'Notes mention an entirely different topic here.', citations: [citation] }));
    render(<NotesPanel onCite={vi.fn()} />);

    const paragraph = screen.getByText(/entirely different topic/);
    selectText('an entirely different topic here', paragraph);

    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open in transcript/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
  });

  it('parks the selected text as chat context instead of asking immediately', () => {
    const ask = vi.fn();
    seed(note({ content: 'Some notes text to ask about.' }));
    useStore.setState({ ask });
    render(<NotesPanel onCite={vi.fn()} />);

    const paragraph = screen.getByText(/notes text to ask about/);
    selectText('notes text to ask about', paragraph);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    // Nothing is sent yet — the user still has to write their own question.
    expect(ask).not.toHaveBeenCalled();
    expect(useStore.getState().askContext).toEqual({
      text: 'notes text to ask about',
      citation: null,
    });
  });

  it('hides the toolbar once the selection is cleared', () => {
    seed(note({ content: 'Some plain notes text here.' }));
    render(<NotesPanel onCite={vi.fn()} />);

    const paragraph = screen.getByText(/plain notes text/);
    selectText('plain notes text', paragraph);
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();

    clearSelection();
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument();
  });
});
