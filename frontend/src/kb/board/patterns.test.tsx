import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PatternFrame } from './PatternFrame';
import { PATTERNS } from './patterns';
import { DEFAULT_LOOK } from './route';

const html = document.documentElement;
const ready = () => waitFor(() => expect(html.dataset.boardReady).toBe('true'), { timeout: 8000 });

beforeEach(() => {
  delete html.dataset.boardReady;
  delete html.dataset.boardErrors;
});

describe('layer 3 · pattern registry', () => {
  it('has unique ids a route can carry, and every pattern the brief asks for', () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(ids).toEqual(expect.arrayContaining([
      'chat-rows', 'chat-exchange', 'composer', 'wiki-page', 'material-rows', 'notification-rows',
      'settings-wiki', 'toast', 'permission', 'question',
    ]));
    for (const p of PATTERNS) expect(p.cells.length, p.id).toBeGreaterThan(0);
  });
});

describe('layer 3 · every pattern mounts on the browser fake', () => {
  it.each(PATTERNS.map((p) => p.id))('%s', async (id) => {
    const { container } = render(<PatternFrame id={id} look={DEFAULT_LOOK} />);
    await ready();
    expect(html.dataset.boardErrors).toBeUndefined();
    const pattern = PATTERNS.find((p) => p.id === id)!;
    expect(container.querySelectorAll('.kb-board__pstage')).toHaveLength(pattern.cells.length);
    // Every cell shows its real component, none is left empty.
    for (const stage of container.querySelectorAll('.kb-board__pstage')) {
      if (id === 'toast' || id.startsWith('settings-')) continue; // portals to <body>, checked below
      expect(stage.childElementCount, `${id}: empty cell`).toBeGreaterThan(0);
    }
  }, 15_000);
});

describe('layer 3 · states are the real ones', () => {
  it('chat rows: current, pinned, answering, new answer, waiting; ⌘-click selects', async () => {
    const { container } = render(<PatternFrame id="chat-rows" look={DEFAULT_LOOK} />);
    await ready();
    const [states, selected] = [...container.querySelectorAll<HTMLElement>('.kb-board__pstage')];
    expect(states!.querySelector('.kb-chatrow.is-current')).toHaveTextContent('Why is there a logarithm in the loss?');
    expect(within(states!).getByRole('region', { name: 'Pinned' })).toBeInTheDocument();
    expect(within(states!).getByRole('img', { name: 'answering' })).toBeInTheDocument();
    expect(within(states!).getByRole('img', { name: 'new answer' })).toBeInTheDocument();
    expect(within(states!).getAllByTestId('chat-waiting').length).toBeGreaterThan(0);
    expect(states!.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    await waitFor(() => expect(selected!.querySelectorAll('[aria-selected="true"]')).toHaveLength(2));
  }, 15_000);

  it('chat rows: the side list sits next to a centre sheet, so the open chat’s bridge meets it (B1)', async () => {
    const { container } = render(<PatternFrame id="chat-rows" look={DEFAULT_LOOK} />);
    await ready();
    const stages = [...container.querySelectorAll<HTMLElement>('.kb-board__pstage')];
    expect(stages).toHaveLength(2);
    for (const stage of stages) {
      // The window's order: side ground · gutter · centre sheet, the side clipped like the app's
      // (it may reach across the gutter, nothing more).
      expect(stage).toHaveClass('kb-board__pane--side', 'kb-board__pane--bridged');
      const sheet = stage.nextElementSibling;
      expect(sheet).toHaveClass('kb-board__sheet');
      expect(sheet).toHaveAttribute('aria-hidden', 'true');
      expect(stage.parentElement).toHaveClass('kb-board__window');
      // The real list draws the bridge for the open chat.
      expect(stage.querySelector('.kb-tab--bridge')).not.toBeNull();
    }
    // Cells of other side panels keep the plain pane (no bridge to show there).
    const other = render(<PatternFrame id="notification-rows" look={DEFAULT_LOOK} />);
    await ready();
    expect(other.container.querySelector('.kb-board__sheet')).toBeNull();
  }, 15_000);

  it('chat exchange: citations with the sources row, thinking, Resume, the failed Regenerate', async () => {
    render(<PatternFrame id="chat-exchange" look={DEFAULT_LOOK} />);
    await ready();
    expect(screen.getByRole('article', { name: 'Your question' })).toHaveTextContent('Why is there a logarithm in the loss function?');
    expect(screen.getByText('Writing an answer…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByText('Answer interrupted: subscription limit')).toBeInTheDocument();
    expect(screen.getByText('Claude Code can’t answer now: Not signed in.')).toBeInTheDocument();
  }, 15_000);

  it('composer: empty, with the handed-over text, with three attachment states', async () => {
    const { container } = render(<PatternFrame id="composer" look={DEFAULT_LOOK} />);
    await ready();
    const [empty, text, attached] = [...container.querySelectorAll<HTMLElement>('.kb-board__pstage')];
    expect(empty!.querySelector('.kb-attachments')).toBeNull();
    expect(text).toHaveTextContent('How is Boltzmann’s entropy related to the cross-entropy loss?');
    expect(attached!.querySelectorAll('.kb-attachment')).toHaveLength(3);
    expect(attached!.querySelector('.kb-attachment.is-failed')).toHaveTextContent('This file type can’t be read.');
  }, 15_000);

  it('toast: the real toasts stay up (no timer closes them on the board)', async () => {
    render(<PatternFrame id="toast" look={DEFAULT_LOOK} />);
    await ready();
    expect(screen.getAllByTestId('toast')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  }, 15_000);

  it('settings rows: the Settings window at its section', async () => {
    render(<PatternFrame id="settings-wiki" look={DEFAULT_LOOK} />);
    await ready();
    const dialog = screen.getByTestId('settings');
    expect(within(dialog).getByRole('heading', { name: 'Wiki' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('switch').length).toBeGreaterThan(0);
  }, 15_000);

  it('an unknown pattern says so and still lets the script go on', async () => {
    render(<PatternFrame id="nope" look={DEFAULT_LOOK} />);
    expect(screen.getByText('No pattern “nope”.')).toBeInTheDocument();
    await ready();
    expect(html.dataset.boardErrors).toContain('Unknown pattern');
  });
});
