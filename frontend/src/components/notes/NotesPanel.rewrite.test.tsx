import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { useStore } from '../../state/store';
import type { Citation, Note } from '../../api/types';

/**
 * The menu over the document: one right click, every action on the passage.
 *
 * The floating toolbar it replaces appeared on its own at a fixed corner and could
 * not be dismissed; worse, actions that need stored speech behind the selection
 * silently disappeared, so a passage with no source looked like a passage with no
 * such feature. Here they stay visible and say why they cannot run.
 */

const CITED = 'Определение термина звучит так';
const MINE = 'Моя собственная мысль про погоду';

const citation: Citation = {
  segment_id: 'seg-1', start_ms: 12_000, end_ms: 18_000,
  text: 'Определение термина звучит так, если коротко.',
};

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  revision: 3,
  content: `# Конспект\n\n- ${CITED}\n- ${MINE}`,
  title: 'Конспект',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  model: 'test-model',
  citations: [citation],
  ...overrides,
});

const transcript = { id: 'seg-1', start_ms: 0, end_ms: 20_000, text: citation.text };

const seed = (stored: Note) => {
  useStore.setState({
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Лекция', created_at: '2026-01-01T00:00:00Z' } as never],
    detail: {
      segments: [transcript], messages: [], notes: stored, notes_list: [stored],
    } as never,
    recorderState: 'stopped',
    notesGenerating: false,
    notesError: null,
    askContext: null,
    settings: { notes: { model: 'test-model' } } as never,
  });
};

let sent: Array<{ method?: string; path: string; body?: unknown }>;
let preview: Record<string, unknown>;

/** jsdom reports nothing useful about a real Selection; drive the same contract. */
const selectInside = (text: string) => {
  const target = screen.getByText(new RegExp(text.slice(0, 20)));
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text,
    rangeCount: 1,
    anchorNode: target.firstChild ?? target,
  } as unknown as Selection);
  return target;
};

/** Right click the document with `text` selected, and return the menu. */
const menuOver = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const target = selectInside(text);
  await user.pointer({ keys: '[MouseRight]', target });
  return screen.findByRole('menu', { name: 'Действия с фрагментом' });
};

const openNote = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Открыть Конспект' }));
  await screen.findByLabelText('Конспект');
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  sent = [];
  preview = {
    id: 'preview-1', note_id: 'n1', revision: 3,
    start: 0, end: 0, original: CITED, replacement: `${CITED}, и это важно`, citations: [citation],
  };
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: { method?: string; path: string; body?: unknown }) => {
      sent.push(req);
      if (req.path.endsWith('/rewrite')) return { ok: true, status: 200, data: preview as T };
      if (req.path.endsWith('/rewrite/apply')) {
        return { ok: true, status: 200, data: note({
          revision: 4, content: `# Конспект\n\n- ${CITED}, и это важно\n- ${MINE}`,
        }) as T };
      }
      if (req.method === 'GET' && /\/sessions\/[^/]+$/.test(req.path)) {
        return { ok: true, status: 200,
          data: { segments: [transcript], messages: [], notes: null, notes_list: [] } as T };
      }
      return { ok: true, status: 200, data: { notes: [] } as T };
    },
  } as never;
  seed(note());
});

describe('the menu over a passage', () => {
  it('replaces the system menu and carries every action', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);

    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim()))
      .toEqual(['Показать в транскрипции', 'Ask', 'Перегенерировать', 'Копировать', 'Вставить']);
    // The floating toolbar is gone: it was never dismissible and sat at a corner.
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument();
  });

  it('keeps source-bound actions visible but disabled for text the user wrote', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, MINE);

    const jump = within(menu).getByRole('menuitem', { name: /Показать в транскрипции/ });
    const rewrite = within(menu).getByRole('menuitem', { name: /Перегенерировать/ });
    expect(jump).toBeDisabled();
    expect(rewrite).toBeDisabled();
    expect(rewrite).toHaveTextContent('Источник не найден');
    // Copy and Ask never depend on the recording.
    expect(within(menu).getByRole('menuitem', { name: /Копировать/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /^Ask/ })).toBeEnabled();
  });

  it('jumps to the source the selection resolves to', async () => {
    const user = userEvent.setup();
    const onCite = vi.fn();
    render(<NotesPanel onCite={onCite} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);

    await user.click(within(menu).getByRole('menuitem', { name: 'Показать в транскрипции' }));
    expect(onCite).toHaveBeenCalledWith(citation);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('parks the passage as chat context instead of asking immediately', async () => {
    const user = userEvent.setup();
    const ask = vi.fn();
    useStore.setState({ ask });
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);

    await user.click(within(menu).getByRole('menuitem', { name: 'Ask' }));
    expect(ask).not.toHaveBeenCalled();
    expect(useStore.getState().askContext).toEqual({ text: CITED, citation });
  });

  it('closes on Escape without acting', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    await menuOver(user, CITED);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(sent.some((req) => req.path.includes('/rewrite'))).toBe(false);
  });
});

describe('regenerating a passage', () => {
  it('sends only the selected span, with the revision it was read from', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);
    await user.click(within(menu).getByRole('menuitem', { name: 'Перегенерировать' }));

    await waitFor(() => expect(sent.some((req) => req.path.endsWith('/rewrite'))).toBe(true));
    const request = sent.find((req) => req.path.endsWith('/rewrite'))!;
    expect(request.path).toBe('/sessions/s1/notes/n1/rewrite');
    const body = request.body as { start: number; end: number; expected_revision: number };
    const source = note().content;
    expect(source.slice(body.start, body.end)).toBe(CITED);
    expect(body.expected_revision).toBe(3);
  });

  it('shows the old and new passages side by side and stores nothing yet', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);
    await user.click(within(menu).getByRole('menuitem', { name: 'Перегенерировать' }));

    const dialog = await screen.findByRole('dialog', { name: 'Сравнение фрагмента' });
    expect(within(dialog).getByLabelText('Текущий фрагмент')).toHaveTextContent(CITED);
    expect(within(dialog).getByLabelText('Новый фрагмент'))
      .toHaveTextContent(`${CITED}, и это важно`);
    expect(sent.some((req) => req.path.endsWith('/rewrite/apply'))).toBe(false);
  });

  it('leaves the note untouched when the comparison is cancelled', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);
    await user.click(within(menu).getByRole('menuitem', { name: 'Перегенерировать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение фрагмента' });

    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent.some((req) => req.path.endsWith('/rewrite/apply'))).toBe(false);
    expect(useStore.getState().detail!.notes!.content).toBe(note().content);
  });

  it('applies the accepted replacement and keeps the rest of the note', async () => {
    const user = userEvent.setup();
    render(<NotesPanel onCite={vi.fn()} />);
    await openNote(user);
    const menu = await menuOver(user, CITED);
    await user.click(within(menu).getByRole('menuitem', { name: 'Перегенерировать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение фрагмента' });

    await user.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(sent.some((req) => req.path.endsWith('/rewrite/apply'))).toBe(true));
    const apply = sent.find((req) => req.path.endsWith('/rewrite/apply'))!;
    expect(apply.body).toEqual({ preview_id: 'preview-1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const stored = useStore.getState().detail!.notes!;
    expect(stored.content).toContain(`${CITED}, и это важно`);
    // Everything the user wrote themselves survives the rewrite.
    expect(stored.content).toContain(MINE);
  });
});
