import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld, docWorld } from '../test/fakeBridge';
import { block, chatMessage, type FakeWorld } from '../test/fakeKb';
import { diagramFixRequest } from './diagramFix';

const BROKEN = 'flowchart LR\n  A[Loss] --> ';
const GOOD = 'flowchart LR\n  A[Boltzmann] --> B[Shannon]';

// jsdom has no canvas: Pele measures text by its own metrics then (quietly).
beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

describe('D: diagrams in chat answers and wiki pages', () => {
  it('a broken diagram in an answer: “Ask the agent to fix” sends one request, only on click', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    c1.messages.push(chatMessage('c1-a2', 3, 'assistant', new Date().toISOString(),
      [{ type: 'text', text: `Here is the scheme:\n\n\`\`\`mermaid\n${BROKEN}\n\`\`\`\n` }]));
    c1.cursor = 3;
    const r = renderKb({ world });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const chat = screen.getByRole('region', { name: 'Chat' });
    const button = await within(chat).findByRole('button', { name: 'Ask the agent to fix' });
    const sent = () => r.fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages');
    expect(sent()).toHaveLength(0);
    await user.click(button);
    await waitFor(() => expect(sent()).toHaveLength(1));
    const body = sent()[0]!.body as { text: string };
    expect(body.text).toContain('```mermaid');
    expect(body.text).toContain(BROKEN);
    // Decision 10: in the answer language — the wiki language the user chose (English in the fixtures).
    expect(body.text).toContain('Reply in English.');
    // Asked once: the button is spent, a second press can't send the same request again.
    expect(within(chat).getByRole('button', { name: /Asked the agent/ })).toBeDisabled();
    expect(sent()).toHaveLength(1);
  });

  it('a diagram in a wiki block is drawn; ✎ opens its text with a live preview', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    const entropy = world.pages.find((p) => p.id === 'p-entropy')!;
    entropy.blocks.push(block('b-diagram', 'explanation', 'Agent explanation', `\`\`\`mermaid\n${GOOD}\n\`\`\``));
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const row = (await within(doc).findByRole('figure', { name: 'Diagram' })).closest('[data-block-id]') as HTMLElement;
    await waitFor(() => expect(row.querySelector('svg.pele')).not.toBeNull());
    await user.click(within(row).getByRole('button', { name: 'Edit block' }));
    const box = within(row).getByRole('textbox', { name: 'Block text' });
    const preview = await within(row).findByRole('figure', { name: 'Diagram preview' });
    await waitFor(() => expect(preview.textContent).toContain('Shannon'));
    await user.clear(box);
    await user.click(box);
    await user.paste('```mermaid\nflowchart LR\n  A[Gibbs] --> B[Shannon]\n```');
    await waitFor(() => expect(within(row).getByRole('figure', { name: 'Diagram preview' }).textContent).toContain('Gibbs'));
  });

  describe('“Ask the agent to fix” asks for the reply in the answer language (decision 10)', () => {
    async function askFix(world: FakeWorld) {
      const user = userEvent.setup();
      const c1 = world.chats.find((c) => c.id === 'c1')!;
      c1.messages.push(chatMessage('c1-a2', 3, 'assistant', new Date().toISOString(),
        [{ type: 'text', text: `\`\`\`mermaid\n${BROKEN}\n\`\`\`\n` }]));
      c1.cursor = 3;
      const r = renderKb({ world });
      await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
      await user.click(await within(screen.getByRole('region', { name: 'Chat' })).findByRole('button', { name: 'Ask the agent to fix' }));
      const sent = () => r.fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages');
      await waitFor(() => expect(sent()).toHaveLength(1));
      return (sent()[0]!.body as { text: string }).text;
    }

    it('the chosen wiki language names the reply language', async () => {
      const world = chatWorld();
      world.wiki = { ...world.wiki, wiki_language: 'ru', wiki_language_chosen: true };
      const text = await askFix(world);
      expect(text).toContain('Reply in Russian.');
      expect(text).toContain(BROKEN);
    });

    it('no language chosen yet: the reply follows the language of the user’s previous question', async () => {
      const world = chatWorld();
      world.wiki = { ...world.wiki, wiki_language: 'en', wiki_language_chosen: false };
      expect(await askFix(world)).toContain('Reply in the language of my previous question.');
    });

    it('nothing to go by: English', () => {
      expect(diagramFixRequest(BROKEN, 'Parse error', { language: null, hasQuestion: false })).toBe(
        `The diagram in your answer can’t be drawn (Parse error). Please send a corrected Mermaid diagram. Reply in English.\n\n\`\`\`mermaid\n${BROKEN}\n\`\`\``);
    });
  });

  it('Save to wiki without an uncited diagram: the warning says what was left out and why (decision 9)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.saveWarnings = { 'c1-a1': 'Saved without 1 diagram: it has no quotes from your materials.' };
    renderKb({ world });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    await user.click(within(answer).getByRole('button', { name: 'Save to wiki' }));
    expect(await within(centre).findByRole('status')).toHaveTextContent(
      'Saved to the wiki as “Why is there a logarithm in the loss?”. Saved without 1 diagram: it has no quotes from your materials.');
  });

  it('Save the whole chat to the wiki: the same warning', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.saveWarnings = { c1: 'Saved without 2 diagrams: they have no quotes from your materials.' };
    renderKb({ world });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    await user.click(await within(centre).findByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Save to wiki as analysis' }));
    await waitFor(() => expect(within(centre).getByRole('status')).toHaveTextContent(
      'Saved to the wiki as “Why is there a logarithm in the loss?”. Saved without 2 diagrams: they have no quotes from your materials.'));
  });
});
