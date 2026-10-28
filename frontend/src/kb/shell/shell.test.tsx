import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';
import { CENTER_MIN, computeLayout, GUTTER, RAIL_W, resizeLimits, usedWidth } from './layout';
import { unconfiguredWorld } from '../test/fakeBridge';

describe('Window shell', () => {
  it('shows title bar, narrow icon rail (v39) with named sections, search and settings, side panel, chat centre; no document panel', async () => {
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    // Icons only (summary v39): names are accessible names and slide out on hover (v43 B); the graph lives under Wiki.
    for (const label of [/^Chats/, /^Materials/, /^Wiki/, /^Notifications/, /^Search/, /^Settings/]) {
      expect(within(rail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(rail).queryByText('Chats')).not.toBeInTheDocument();
    expect(RAIL_W).toBe(52);
    expect(screen.getByTestId('titlebar')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument();
    // U3: "Record | Folder ▾" and "+ Material" work once the library is ready.
    expect(screen.getByTestId('record-capsule')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
    expect(within(screen.getByTestId('record-capsule')).getByRole('button', { name: 'Record' })).not.toHaveAttribute('aria-disabled');
  });

  it('rail names slide out beside the icon (v43 B): after a short hover, then at once along the rail; focus at once', async () => {
    const user = userEvent.setup();
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    const chats = within(rail).getByRole('button', { name: /^Chats/ });
    const materials = within(rail).getByRole('button', { name: /^Materials/ });
    await user.hover(chats);
    // Not at once on the first hover…
    expect(within(chats).queryByTestId('rail-label')).not.toBeInTheDocument();
    // …but after the reveal delay, inside the button (one shape), decorative.
    const label = await within(chats).findByTestId('rail-label', {}, { timeout: 1000 });
    expect(label).toHaveTextContent('Chats');
    expect(label).toHaveAttribute('aria-hidden', 'true');
    expect(chats).toHaveAccessibleName('Chats');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    // Moving along the rail: the next name comes at once, the previous one is gone.
    await user.hover(materials);
    expect(within(materials).getByTestId('rail-label')).toHaveTextContent('Materials');
    expect(within(chats).queryByTestId('rail-label')).not.toBeInTheDocument();
    await user.unhover(materials);
    expect(within(rail).queryByTestId('rail-label')).not.toBeInTheDocument();
    // Escape hides it.
    await user.hover(materials);
    await user.keyboard('{Escape}');
    expect(within(rail).queryByTestId('rail-label')).not.toBeInTheDocument();
  });

  it('the rail has no SKAZ wordmark any more (the empty chat shows SKAZ): only sections, search and settings', async () => {
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    expect(rail.querySelector('.kb-rail__wordmark')).toBeNull();
    expect(rail).not.toHaveTextContent('SKAZ');
  });

  it('keyboard focus shows the rail name at once; search and settings carry their shortcut, muted', async () => {
    const user = userEvent.setup();
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    const search = within(rail).getByRole('button', { name: 'Search' });
    within(rail).getByRole('button', { name: /^Notifications/ }).focus();
    await user.tab();
    expect(search).toHaveFocus();
    const label = within(search).getByTestId('rail-label');
    expect(label).toHaveTextContent('Search⌘K');
    expect(label.querySelector('.kb-rail__hint')).toHaveTextContent('⌘K');
    await user.tab();
    const settings = within(rail).getByRole('button', { name: /^Settings/ });
    expect(within(settings).getByTestId('rail-label')).toHaveTextContent(/^Settings/);
    expect(within(search).queryByTestId('rail-label')).not.toBeInTheDocument();
  });

  it('collapses the side panel to the rail and opens it again from a rail item; the choice is kept', async () => {
    const user = userEvent.setup();
    renderKb();
    const toggle = await screen.findByRole('button', { name: 'Hide side panel' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Chats' })).not.toBeInTheDocument();
    expect(storedPrefs().sideOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Show side panel' })).toHaveAttribute('aria-pressed', 'false');
    // The composer stays where it is.
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Materials/ }));
    expect(await screen.findByRole('region', { name: 'Materials' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Materials/ })).toHaveAttribute('aria-current', 'page');
    expect(storedPrefs()).toMatchObject({ sideOpen: true, section: 'materials' });
  });

  it('quiet rail (decision 24): the active section is a soft tile with one sliding mark; no mark while the panel is closed', async () => {
    const user = userEvent.setup();
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    const chats = within(rail).getByRole('button', { name: /^Chats/ });
    expect(chats).toHaveClass('is-active');
    expect(rail.querySelector('.kb-rail__fill')).toBeNull();
    const mark = within(rail).getByTestId('rail-mark');
    expect(rail.querySelectorAll('[data-testid="rail-mark"]')).toHaveLength(1);
    expect(mark).toHaveAttribute('data-section', 'chats');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    await user.click(within(rail).getByRole('button', { name: /^Wiki/ }));
    // The same element moves to the new item.
    expect(within(rail).getByTestId('rail-mark')).toBe(mark);
    expect(mark).toHaveAttribute('data-section', 'wiki');
    await user.click(screen.getByRole('button', { name: 'Hide side panel' }));
    expect(within(rail).queryByTestId('rail-mark')).not.toBeInTheDocument();
    expect(rail.querySelector('.kb-rail__item.is-active')).toBeNull();
  });

  it('the rail mark re-measures when the items move without a section change (density, text size, window height; FIX1 R1)', async () => {
    const observers: Array<{ cb: ResizeObserverCallback; els: Element[] }> = [];
    class FakeResizeObserver {
      els: Element[] = [];
      constructor(cb: ResizeObserverCallback) { observers.push({ cb, els: this.els }); }
      observe(el: Element) { this.els.push(el); }
      unobserve() {}
      disconnect() { this.els.length = 0; }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      renderKb();
      const rail = await screen.findByRole('navigation', { name: 'Sections' });
      const list = rail.querySelector('.kb-rail__list')!;
      const mark = within(rail).getByTestId('rail-mark');
      const chats = within(rail).getByRole('button', { name: /^Chats/ });
      // The items moved (a denser layout): nothing in React changed, only the list's size.
      Object.defineProperty(chats, 'offsetTop', { configurable: true, value: 100 });
      Object.defineProperty(chats, 'offsetHeight', { configurable: true, value: 36 });
      const watching = observers.filter((o) => o.els.includes(list));
      expect(watching.length).toBeGreaterThan(0);
      act(() => { for (const o of watching) o.cb([], {} as ResizeObserver); });
      expect(mark).toHaveAttribute('data-y', String(100 + (36 - 20) / 2));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a section switch crossfades the side panel body in 140 ms (opacity only); nothing at calm', async () => {
    const user = userEvent.setup();
    const played: Array<{ el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions }> = [];
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    proto.animate = function animate(this: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      played.push({ el: this, frames, opts });
      return { cancel() {}, finish() {}, onfinish: null };
    };
    try {
      renderKb();
      const rail = await screen.findByRole('navigation', { name: 'Sections' });
      await user.click(within(rail).getByRole('button', { name: /^Materials/ }));
      const body = () => document.querySelector('.kb-side__body')!;
      const fades = () => played.filter((p) => p.el === body());
      expect(fades().map((p) => [p.frames, p.opts.duration])).toEqual([[[{ opacity: 0 }, { opacity: 1 }], 140]]);
      document.documentElement.dataset.motion = 'calm';
      await user.click(within(rail).getByRole('button', { name: /^Wiki/ }));
      expect(fades()).toHaveLength(1);
    } finally {
      delete proto.animate;
      delete document.documentElement.dataset.motion;
    }
  });

  it('shows the notification count from /kb/notifications (dismissed ones excluded)', async () => {
    renderKb();
    const bell = await screen.findByRole('button', { name: /Notifications/ });
    await waitFor(() => expect(bell).toHaveTextContent('1'));
    expect(bell).toHaveAccessibleName('Notifications, 1 unread');
  });

  it('opens a material on the right, expands it over the centre and closes it', async () => {
    const user = userEvent.setup();
    renderKb({ prefs: { section: 'materials' } });
    await user.click(await screen.findByRole('button', { name: /Pasted text: problems/ }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByRole('heading', { name: 'Pasted text: problems' })).toBeInTheDocument();
    expect(within(doc).getByText('First paragraph of the source.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeVisible();

    const expand = within(doc).getByRole('button', { name: 'Expand to the centre' });
    await user.click(expand);
    expect(doc).toHaveAttribute('data-state', 'expanded');
    expect(document.querySelector('[data-pane="center"]')).not.toBeVisible();
    expect(within(doc).getByRole('button', { name: 'Back to side panel' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(doc).getByRole('button', { name: 'Close document' }));
    expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeVisible();
  });

  it('remembers column widths changed by dragging or by keyboard', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    renderKb({ prefs: { section: 'materials' } });
    const sep = await screen.findByRole('separator', { name: 'Resize side panel' });
    expect(sep).toHaveAttribute('aria-valuenow', '248');
    sep.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(sep).toHaveAttribute('aria-valuenow', '280');
    expect(storedPrefs().sideWidth).toBe(280);
    act(() => {
      fireEvent.pointerDown(sep, { button: 0, clientX: 300, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientX: 260, pointerId: 1 });
      fireEvent.pointerUp(sep, { clientX: 260, pointerId: 1 });
    });
    expect(storedPrefs().sideWidth).toBe(240);
    await user.keyboard('{Home}');
    expect(storedPrefs().sideWidth).toBe(200);

    await user.click(screen.getByRole('button', { name: /Lecture 8/ }));
    const right = await screen.findByRole('separator', { name: 'Resize document panel' });
    right.focus();
    await user.keyboard('{ArrowLeft}');
    expect(storedPrefs().rightWidth).toBe(416);
  });

  it('the side pane owns its gutter (FIX1 S1): its box is the column plus the gutter, the resizer sits on that gutter', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    renderKb();
    const side = await screen.findByRole('region', { name: 'Chats' });
    expect(side).toHaveAttribute('data-pane', 'side');
    // The chat list and its bridge reach the centre sheet without leaving [data-pane=side] (paneAudit).
    expect(side.style.width).toBe(`${248 + GUTTER}px`);
    const sep = screen.getByRole('separator', { name: 'Resize side panel' });
    // The stored width (and the resizer's value) is still the column without the gutter.
    expect(sep).toHaveAttribute('aria-valuenow', '248');
    // Right after the pane in the row; CSS pulls it back over the pane's gutter (shell.css `.kb-side + .kb-resizer`).
    expect(side.nextElementSibling).toBe(sep);
  });

  it('answers the quit barrier at once: this interface holds no unsaved capture', async () => {
    const { fake, unmount } = renderKb();
    await screen.findByRole('navigation', { name: 'Sections' });
    await expect(fake.prepareQuit()).resolves.toBe(true);
    unmount();
    await expect(fake.prepareQuit()).resolves.toBeNull();
  });

  it('the library-not-connected screen leads to the library step of first launch', async () => {
    const user = userEvent.setup();
    renderKb({ world: unconfiguredWorld(), prefs: { section: 'materials' } });
    await user.click(await screen.findByRole('button', { name: 'Choose where to keep it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Library' });
    expect(within(dialog).getByTestId('library-path')).toHaveTextContent('/Users/me/Documents/SKAZ');
    await user.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Library' })).not.toBeInTheDocument());
    const side = screen.getByRole('region', { name: 'Materials' });
    expect(await within(side).findByText('Inbox')).toBeInTheDocument();
  });
});

describe('Column layout', () => {
  it('fits every column and every gutter at 960, 1024 and 1440 px with the document open', () => {
    for (const windowWidth of [960, 1024, 1440]) {
      const l = computeLayout({ windowWidth, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 });
      // rail · side · gutter · centre · gutter · document · gutter (decision 24 «Windows»)
      const used = RAIL_W + l.side + GUTTER + 340 + GUTTER + (l.right ?? 0) + GUTTER;
      expect(used, `width ${windowWidth}`).toBeLessThanOrEqual(windowWidth);
      expect(usedWidth(l), `width ${windowWidth}`).toBe(used);
      expect(l.side).toBeGreaterThanOrEqual(200);
      expect(l.right!).toBeGreaterThanOrEqual(320);
    }
    expect(GUTTER).toBe(8);
    expect(computeLayout({ windowWidth: 1440, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 }))
      .toEqual({ side: 248, right: 400, centerVisible: true });
    // 960: the gutters cost 24px, the document gives way first, the side panel keeps its minimum.
    expect(computeLayout({ windowWidth: 960, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 }))
      .toEqual({ side: 200, right: 344, centerVisible: true });
  });

  it('never overflows: any window from 820 (the board\'s narrowest screen) to 1800 px, any stored widths, panels open or closed', () => {
    const widths: number[] = [];
    for (let w = 820; w <= 1800; w += 37) widths.push(w);
    widths.push(960, 1024); // the Electron minimum and the common small screen, exactly
    for (const windowWidth of widths) {
      for (const sideOpen of [true, false]) {
        for (const docOpen of [true, false]) {
          for (const docExpanded of [false, true]) {
            for (const [sideWidth, rightWidth] of [[200, 320], [248, 400], [360, 640]] as const) {
              const l = computeLayout({ windowWidth, sideOpen, sideWidth, docOpen, docExpanded, rightWidth });
              const tag = JSON.stringify({ windowWidth, sideOpen, docOpen, docExpanded, sideWidth, rightWidth });
              expect(usedWidth(l), tag).toBeLessThanOrEqual(windowWidth);
              if (l.side > 0) expect(l.side, tag).toBeGreaterThanOrEqual(200);
            }
          }
        }
      }
    }
  });

  it('layout GUTTER is the same gap as --kb-gutter in tokens.css (FIX1 R11)', () => {
    const css = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
    const decl = css.match(/--kb-gutter:\s*([^;]+);/);
    expect(decl, '--kb-gutter is declared').not.toBeNull();
    expect(decl![1]!.trim()).toBe(`${GUTTER}px`);
    // Declared once, so no theme or density override can drift from the layout maths.
    expect(css.match(/--kb-gutter:/g)).toHaveLength(1);
  });

  it('a closed side panel takes no room and no gutter; the centre then starts at the rail', () => {
    const l = computeLayout({ windowWidth: 1024, sideOpen: false, sideWidth: 248, docOpen: false, docExpanded: false, rightWidth: 400 });
    expect(l).toEqual({ side: 0, right: null, centerVisible: true });
    expect(usedWidth(l)).toBe(RAIL_W + CENTER_MIN + GUTTER);
  });

  it('resizers stop where the centre would drop below its minimum, gutters included', () => {
    const l = computeLayout({ windowWidth: 1024, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 });
    const { sideMax, rightMax } = resizeLimits(1024, l);
    expect(usedWidth({ ...l, side: sideMax })).toBeLessThanOrEqual(1024);
    expect(sideMax).toBe(1024 - RAIL_W - 3 * GUTTER - CENTER_MIN - l.right!);
    expect(rightMax).toBe(1024 - RAIL_W - 3 * GUTTER - CENTER_MIN - l.side);
    // A wide window: the stored maximums cap them.
    expect(resizeLimits(2400, computeLayout({ windowWidth: 2400, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 })))
      .toEqual({ sideMax: 360, rightMax: 640 });
  });

  it('expanded document takes the centre; a closed side panel takes no room', () => {
    expect(computeLayout({ windowWidth: 1024, sideOpen: false, sideWidth: 248, docOpen: true, docExpanded: true, rightWidth: 400 }))
      .toEqual({ side: 0, right: null, centerVisible: false });
    const l = computeLayout({ windowWidth: 1024, sideOpen: true, sideWidth: 360, docOpen: true, docExpanded: true, rightWidth: 400 });
    expect(l).toEqual({ side: 360, right: null, centerVisible: false });
    expect(usedWidth(l)).toBeLessThanOrEqual(1024);
  });
});
