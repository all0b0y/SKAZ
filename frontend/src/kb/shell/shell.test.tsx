import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';
import { computeLayout, RAIL_W } from './layout';
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

  it('the rail carries a vertical SKAZ wordmark above Search (v44 A): decorative, not a control', async () => {
    renderKb();
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    const mark = rail.querySelector('.kb-rail__wordmark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('SKAZ');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark!.closest('button, a, [tabindex]')).toBeNull();
    // Between the sections and Search, in the flexible space.
    const search = within(rail).getByRole('button', { name: 'Search' });
    expect(mark!.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark!.parentElement).toHaveClass('kb-rail__spacer');
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
  it('fits every column at 960, 1024 and 1440 px with the document open', () => {
    for (const windowWidth of [960, 1024, 1440]) {
      const l = computeLayout({ windowWidth, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 });
      const used = RAIL_W + l.side + 340 + (l.right ?? 0);
      expect(used, `width ${windowWidth}`).toBeLessThanOrEqual(windowWidth);
      expect(l.side).toBeGreaterThanOrEqual(200);
      expect(l.right!).toBeGreaterThanOrEqual(320);
    }
    expect(computeLayout({ windowWidth: 1440, sideOpen: true, sideWidth: 248, docOpen: true, docExpanded: false, rightWidth: 400 }))
      .toEqual({ side: 248, right: 400, centerVisible: true });
  });

  it('expanded document takes the centre; a closed side panel takes no room', () => {
    expect(computeLayout({ windowWidth: 1024, sideOpen: false, sideWidth: 248, docOpen: true, docExpanded: true, rightWidth: 400 }))
      .toEqual({ side: 0, right: null, centerVisible: false });
  });
});
