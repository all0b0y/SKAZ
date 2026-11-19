import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { serveFake } from '../../test/fakeKb';
import { chatWorld, docWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

const lecture = 'Lecture 8 — entropy';
const panel = (name = 'Document') => screen.getByRole('complementary', { name });
const header = (name?: string) => within(panel(name).querySelector('header')!);

describe('The reader in the production shell', () => {
  it('keeps the same chat and draft while a citation opens beside it and Back restores manual expansion', async () => {
    const user = userEvent.setup();
    const docs = docWorld();
    const chats = chatWorld();
    const world = { ...docs, chats: chats.chats };
    const { services } = renderKb({ world });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const chat = screen.getByRole('region', { name: 'Chat' });
    const draft = await within(chat).findByRole('textbox', { name: 'Message' });
    await user.type(draft, 'Keep this draft');
    const chatId = services.chats.getState().currentId;

    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
    await within(panel()).findByRole('heading', { name: 'Entropy' });
    expect(panel()).toHaveAttribute('data-state', 'open');
    await user.click(header().getByRole('button', { name: 'Expand to the centre' }));
    expect(panel()).toHaveAttribute('data-state', 'expanded');
    expect(chat).toHaveAttribute('hidden');

    const source = (await within(panel()).findAllByRole('button', { name: 'Source 1: Lecture 8 — entropy' }))[0]!;
    await user.click(source);
    const preview = await screen.findByRole('dialog', { name: lecture });
    const jump = within(preview).getByRole('button', { name: 'Open at quote, 08:12' });
    await waitFor(() => expect(jump).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(source).toHaveFocus();
    expect(source).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: lecture }))
      .getByRole('button', { name: 'Open at quote, 08:12' })).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(panel()).toHaveAttribute('data-state', 'open');
    expect(chat).not.toHaveAttribute('hidden');
    await within(panel()).findByRole('heading', { name: lecture });
    expect(panel().querySelector('mark.kb-quote')).toHaveTextContent('S equals k times the log of W');
    expect(panel().querySelector('mark.kb-quote')).toHaveFocus();

    await user.keyboard('{Control>}[[{/Control}');
    await within(panel()).findByRole('heading', { name: 'Entropy' });
    expect(panel()).toHaveAttribute('data-state', 'expanded');
    const restored = within(panel()).getAllByRole('button', { name: 'Source 1: ' + lecture })[0]!;
    expect(restored).toHaveFocus();
    expect(restored).toHaveAttribute('aria-expanded', 'false');
    const collapse = header().getByRole('button', { name: 'Back to side panel' });
    collapse.focus();
    await user.keyboard('{Enter}');
    expect(collapse).toHaveAccessibleName('Expand to the centre');
    expect(collapse).toHaveFocus();
    expect(panel()).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('region', { name: 'Chat' })).toBe(chat);
    expect(within(chat).getByRole('textbox', { name: 'Message' })).toBe(draft);
    expect(draft).toHaveTextContent('Keep this draft');
    expect(screen.getAllByTestId('composer')).toHaveLength(1);
    expect(services.chats.getState().currentId).toBe(chatId);
  });

  it('puts Notes in the material header and keeps the material and page menus operable by keyboard', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: docWorld() });
    act(() => services.ui.getState().openDoc('m-lec8'));
    await within(panel()).findByRole('heading', { name: lecture });
    const menuButton = header().getByRole('button', { name: 'Material actions' });
    await user.click(menuButton);
    const menu = screen.getByRole('menu', { name: 'Material actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Move to folder' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Topic ▸' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(menuButton).toHaveFocus();
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    header().getByRole('button', { name: 'Open the notes' }).focus();
    await user.keyboard('{Enter}');
    await within(panel()).findByRole('heading', { name: 'Notes: ' + lecture });
    expect(panel()).toHaveAttribute('data-state', 'open');
    await waitFor(() => expect(header().getByRole('button', { name: 'Transcript' })).toHaveFocus());
    const pageMenuButton = header().getByRole('button', { name: 'Page actions' });
    await user.click(pageMenuButton);
    expect(within(screen.getByRole('menu', { name: 'Page actions' })).getByRole('menuitem', { name: 'Show the graph' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(pageMenuButton).toHaveFocus();

    header().getByRole('button', { name: 'Transcript' }).focus();
    await user.keyboard('{Enter}');
    await within(panel()).findByRole('heading', { name: lecture });
    expect(panel()).toHaveAttribute('data-state', 'open');
    expect(header().getByRole('button', { name: 'Open the notes' })).toHaveFocus();
    header().getByRole('button', { name: 'Back' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(header().getByRole('button', { name: 'Transcript' })).toHaveFocus());
    await user.click(header().getByRole('button', { name: 'Close document' }));
    expect(screen.queryByRole('complementary', { name: 'Document' })).toBeNull();
  });

  it.each(['removed', 'outdated'])('opens an available transcript from Notes with %s timed citations', async (citations) => {
    const user = userEvent.setup();
    const world = docWorld();
    const notes = world.pages.find((page) => page.id === 'p-note8')!;
    expect(notes.sources).toEqual(['m-lec8']);
    for (const block of notes.blocks) {
      block.citations = citations === 'removed' ? [] : block.citations.map((cite) => ({ ...cite, available: false }));
    }
    const { services, fake } = renderKb({ world });
    act(() => services.ui.getState().openDocument({ type: 'page', id: notes.id }));
    await within(panel()).findByRole('heading', { name: notes.title });
    const transcript = await header().findByRole('button', { name: 'Transcript' });
    expect(fake.calls.filter(({ method, path }) => method === 'GET' && path === '/kb/materials/m-lec8')).toHaveLength(1);
    transcript.focus();
    await user.keyboard('{Enter}');
    expect(await within(panel()).findByRole('heading', { name: lecture })).toBeVisible();
  });

  it.each([
    { reason: 'missing material', sources: ['m-missing'], reads: 1 },
    { reason: 'PDF', sources: ['m-tb'], reads: 1 },
    { reason: 'empty transcript', sources: ['m-lec8'], reads: 1 },
    { reason: 'ambiguous relation', sources: ['m-lec8', 'm-lec7'], reads: 0 },
    { reason: 'no relation', sources: [], reads: 0 },
  ])('omits Transcript for Notes with $reason', async ({ reason, sources, reads }) => {
    const world = docWorld();
    const notes = world.pages.find((page) => page.id === 'p-note8')!;
    notes.sources = sources;
    if (reason === 'empty transcript') world.materials.find((material) => material.id === 'm-lec8')!.fragments = [];
    // A stale timestamp or availability flag cannot establish that this material is readable speech.
    notes.blocks[0]!.citations[0]!.material_id = sources[0] ?? 'm-lec8';
    const { services, fake } = renderKb({ world });
    act(() => services.ui.getState().openDocument({ type: 'page', id: notes.id }));
    await within(panel()).findByRole('heading', { name: notes.title });
    const sourceReads = fake.calls.filter(({ method, path }) => method === 'GET' && path.startsWith('/kb/materials/'));
    expect(sourceReads).toHaveLength(reads);
    expect(header().queryByRole('button', { name: 'Transcript' })).toBeNull();
  });

  it('keeps focus in the chat if the user moves there before the destination finishes loading', async () => {
    const user = userEvent.setup();
    const { services, fake } = renderKb({ world: { ...docWorld(), chats: chatWorld().chats } });
    await user.click(await screen.findByRole('button', { name: /Why is there a logarithm/ }));
    const draft = await screen.findByRole('textbox', { name: 'Message' });
    act(() => services.ui.getState().openDoc('m-lec8'));
    const notes = await header().findByRole('button', { name: 'Open the notes' });
    let finishLoading!: () => void;
    const gate = new Promise<void>((resolve) => { finishLoading = resolve; });
    fake.requestMock.mockImplementation(async (request) => {
      if (request.path === '/kb/wiki/pages/p-note8') await gate;
      return serveFake(fake.world, request)!;
    });
    draft.focus();
    expect(draft).toHaveFocus();
    notes.focus();
    await user.keyboard('{Enter}');
    expect(panel()).toHaveFocus();
    await user.click(draft);
    await user.type(draft, 'Still typing');
    await act(async () => { finishLoading(); });
    await header().findByRole('button', { name: 'Transcript' });
    expect(draft).toHaveFocus();
    expect(draft).toHaveTextContent('Still typing');

    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-lec8', seg: 1 }));
    await within(panel()).findByRole('heading', { name: lecture });
    expect(draft).toHaveFocus();
  });

  it('focuses the reader error if the Notes page disappears before it opens', async () => {
    const user = userEvent.setup();
    const { services, fake } = renderKb({ world: docWorld() });
    act(() => services.ui.getState().openDoc('m-lec8'));
    const notes = await header().findByRole('button', { name: 'Open the notes' });
    fake.world.pages = fake.world.pages.filter((page) => page.id !== 'p-note8');
    notes.focus();
    await user.keyboard('{Enter}');
    const error = await within(panel()).findByRole('alert');
    expect(error).toHaveTextContent('Couldn’t open this page.');
    expect(error).toHaveFocus();
  });

  it('falls back to the page heading when the original citation disappears during a round trip', async () => {
    const user = userEvent.setup();
    const { services, fake } = renderKb({ world: docWorld() });
    act(() => services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
    const source = (await within(panel()).findAllByRole('button', { name: 'Source 1: ' + lecture }))[0]!;
    act(() => source.focus());
    await user.keyboard('{Enter}');
    const jump = await screen.findByRole('button', { name: 'Open at quote, 08:12' });
    await waitFor(() => expect(jump).toHaveFocus());
    await user.keyboard('{Enter}');
    await within(panel()).findByRole('heading', { name: lecture });
    fake.world.pages.find((page) => page.id === 'p-entropy')!.blocks.find((block) => block.id === 'b2')!.citations = [];
    header().getByRole('button', { name: 'Back' }).focus();
    await user.keyboard('{Enter}');
    expect(await within(panel()).findByRole('heading', { name: 'Entropy' })).toHaveFocus();
  });

  it('keeps Wiki files and the live transcript readable through the same expand and close controls', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.wikiFiles = { index: { text: '# Index\n\nFiled course material.', links: [] }, log: { text: '', links: [] } };
    const { services } = renderKb({ world });
    act(() => services.ui.getState().openWikiFile('index'));
    expect(await within(panel()).findByText('Filed course material.')).toBeVisible();
    expect(header().getByText('Wiki index')).toBeVisible();
    await user.click(header().getByRole('button', { name: 'Expand to the centre' }));
    expect(panel()).toHaveAttribute('data-state', 'expanded');

    act(() => services.ui.getState().openLive('m-lec8'));
    await within(panel('Live recording')).findByRole('heading', { name: lecture });
    expect(header('Live recording').getByText('Recording')).toBeVisible();
    expect(panel('Live recording')).toHaveAttribute('data-state', 'open');
    await user.click(header('Live recording').getByRole('button', { name: 'Expand to the centre' }));
    expect(panel('Live recording')).toHaveAttribute('data-state', 'expanded');
    await user.click(header('Live recording').getByRole('button', { name: 'Close live transcript' }));
    expect(screen.queryByRole('complementary', { name: 'Live recording' })).toBeNull();
  });
});
