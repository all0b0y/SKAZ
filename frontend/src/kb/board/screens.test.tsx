import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { screenGrid } from './BoardCanvas';
import { DEFAULT_LOOK } from './route';
import { ScreenFrame } from './ScreenFrame';
import { SCREENS } from './screens';

const html = document.documentElement;
const ready = () => waitFor(() => expect(html.dataset.boardReady).toBe('true'), { timeout: 8000 });

beforeEach(() => {
  delete html.dataset.boardReady;
  delete html.dataset.boardErrors;
});

describe('layer 4 · screen registry', () => {
  it('has unique ids a route can carry, and every screen the brief asks for', () => {
    const ids = SCREENS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(ids).toEqual(expect.arrayContaining(['chat', 'chat-source', 'wiki-page', 'materials', 'settings-look', 'notifications', 'onboarding']));
  });
});

describe('layer 4 · the canvas grid', () => {
  it('is «screen × width», both themes, each frame at its window size', () => {
    const grid = screenGrid([1440, 1024, 820]);
    expect(grid.map((g) => g.screen.id)).toEqual(SCREENS.map((s) => s.id));
    for (const { rows } of grid) {
      expect(rows.map((r) => r.theme)).toEqual(['light', 'dark']);
      for (const r of rows) expect(r.frames.map(({ w, h }) => [w, h])).toEqual([[1440, 900], [1024, 768], [820, 700]]);
    }
    const keys = grid.flatMap((g) => g.rows.flatMap((r) => r.frames.map((f) => f.key)));
    expect(new Set(keys).size).toBe(SCREENS.length * 6);
  });

  it('shows only the widths that are switched on', () => {
    expect(screenGrid([820]).flatMap((g) => g.rows.flatMap((r) => r.frames.map((f) => f.w)))).toEqual(Array(SCREENS.length * 2).fill(820));
  });
});

describe('layer 4 · every screen is the real app in its state', () => {
  it.each(SCREENS.map((s) => s.id))('%s mounts without errors', async (id) => {
    render(<ScreenFrame id={id} look={{ ...DEFAULT_LOOK, theme: 'dark', density: 'spacious' }} />);
    await ready();
    expect(html.dataset.boardErrors).toBeUndefined();
    // The frame's look reached <html> through the app's own ThemeSync.
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.density).toBe('spacious');
  }, 15_000);

  it('chat: the answer is on screen', async () => {
    render(<ScreenFrame id="chat" look={DEFAULT_LOOK} />);
    await ready();
    await waitFor(() => expect(screen.getByRole('article', { name: 'Answer' })).toBeInTheDocument());
  }, 15_000);

  it('chat-source: the cited material opens beside the chat', async () => {
    const { container } = render(<ScreenFrame id="chat-source" look={DEFAULT_LOOK} />);
    await ready();
    await waitFor(() => expect(container.querySelector('[data-pane="doc"][data-view="material"]')).not.toBeNull());
    expect(screen.getByRole('article', { name: 'Answer' })).toBeInTheDocument();
  }, 15_000);

  it('wiki-page: the page in the document panel and the Wiki side panel', async () => {
    const { container } = render(<ScreenFrame id="wiki-page" look={DEFAULT_LOOK} />);
    await ready();
    expect(container.querySelector('[data-pane="doc"][data-view="page"]')).not.toBeNull();
    expect(container.querySelector('[data-section="wiki"]')).not.toBeNull();
  }, 15_000);

  it('settings-look: Settings open at Appearance', async () => {
    render(<ScreenFrame id="settings-look" look={DEFAULT_LOOK} />);
    await ready();
    expect(within(screen.getByTestId('settings')).getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  }, 15_000);

  it('onboarding: the first step of first launch', async () => {
    render(<ScreenFrame id="onboarding" look={DEFAULT_LOOK} />);
    await ready();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  }, 15_000);

  it('an unknown screen says so', async () => {
    render(<ScreenFrame id="nope" look={DEFAULT_LOOK} />);
    expect(screen.getByText('No screen “nope”.')).toBeInTheDocument();
    await ready();
    expect(html.dataset.boardErrors).toContain('Unknown screen');
  });
});
