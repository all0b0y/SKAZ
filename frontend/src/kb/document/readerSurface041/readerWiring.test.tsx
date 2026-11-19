import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
    await user.click(source);
    await user.click(within(await screen.findByRole('dialog', { name: lecture })).getByRole('button', { name: 'Open at quote, 08:12' }));
    expect(panel()).toHaveAttribute('data-state', 'open');
    expect(chat).not.toHaveAttribute('hidden');
    await within(panel()).findByRole('heading', { name: lecture });
    expect(panel().querySelector('mark.kb-quote')).toHaveTextContent('S equals k times the log of W');

    await user.keyboard('{Control>}[[{/Control}');
    await within(panel()).findByRole('heading', { name: 'Entropy' });
    expect(panel()).toHaveAttribute('data-state', 'expanded');
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
    await user.click(header().getByRole('button', { name: 'Open the notes' }));
    await within(panel()).findByRole('heading', { name: 'Notes: ' + lecture });
    expect(panel()).toHaveAttribute('data-state', 'open');
    const pageMenuButton = header().getByRole('button', { name: 'Page actions' });
    await user.click(pageMenuButton);
    expect(within(screen.getByRole('menu', { name: 'Page actions' })).getByRole('menuitem', { name: 'Show the graph' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(pageMenuButton).toHaveFocus();

    await user.click(header().getByRole('button', { name: 'Transcript' }));
    await within(panel()).findByRole('heading', { name: lecture });
    expect(panel()).toHaveAttribute('data-state', 'open');
    await user.click(header().getByRole('button', { name: 'Close document' }));
    expect(screen.queryByRole('complementary', { name: 'Document' })).toBeNull();
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
