import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { b2State } from '../test/fakeB2';
import { InlineMarkdown } from './Markdown';
import { plainText, toBlocks } from './Message';

const side = () => screen.getByRole('region', { name: 'Chats' });

describe('Chats in the side panel', () => {
  it('pinned first, then by date, a few only, "All chats · N"; answering and new-answer marks are still', async () => {
    renderKb({ b2: b2State() });
    const panel = side();
    const pinned = await within(panel).findByRole('region', { name: 'Pinned' });
    expect(within(pinned).getAllByRole('button').map((b) => b.textContent)).toEqual(['Exam preparation for ML', 'Entropy across folders']);
    const today = within(panel).getByRole('region', { name: 'Today' });
    expect(within(today).getByRole('button', { name: /What did I miss in lecture 8/ })).toBeInTheDocument();
    expect(within(today).getByRole('img', { name: 'answering' })).toBeInTheDocument();
    expect(within(today).getByRole('img', { name: 'new answer' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Yesterday' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'All chats · 7' })).toBeInTheDocument();
    // No blinking: the marks have no animation class.
    expect(panel.querySelector('.kb-chatmark--answering')?.className).not.toMatch(/pulse|blink/);
  });

  it('opens a chat: the answer with page and source chips, the connection folded, the tool trail folded', async () => {
    const user = userEvent.setup();
    const { services } = renderKb({ b2: b2State() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    expect(await within(centre).findByRole('heading', { name: 'Why is there a logarithm in the loss?' })).toBeInTheDocument();
    const answer = await within(centre).findByRole('article', { name: 'Answer' });
    expect(within(answer).getByText('Shannon entropy').tagName).toBe('STRONG');
    // Chips are shapes with an icon and a label, not colour only.
    await user.click(within(answer).getAllByRole('button', { name: 'Wiki page: Entropy' })[0]!);
    expect(services.ui.getState().doc).toMatchObject({ type: 'page', id: 'p-entropy' });
    await user.click(within(answer).getAllByRole('button', { name: 'Recording: Lecture 5, 44:00' })[0]!);
    expect(services.ui.getState().doc).toMatchObject({ type: 'material', id: 'm5', seg: 3 });
    expect(screen.getByRole('complementary', { name: 'Document' })).toBeInTheDocument();

    const pill = within(answer).getByRole('button', { name: /Connection · 3 folders/ });
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    await user.click(pill);
    const rows = within(answer).getByRole('list', { name: 'Connection across folders' });
    expect(within(rows).getByText('S = k·ln W')).toBeInTheDocument();
    expect(within(rows).getByText('Agent inference:')).toBeInTheDocument();
    expect(within(answer).getByRole('button', { name: /Looked at 1 thing/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('sends a question in a new chat; the answer arrives and the list moves it to the top', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const input = screen.getByTestId('message-input');
    await user.click(input);
    await user.keyboard('What is entropy?');
    await user.keyboard('{Enter}');
    const centre = screen.getByRole('region', { name: 'Chat' });
    expect(await within(centre).findByRole('article', { name: 'Your question' })).toHaveTextContent('What is entropy?');
    await waitFor(() => expect(within(centre).getByRole('article', { name: 'Answer' })).toHaveTextContent('Cross-entropy is Shannon entropy'));
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/chats')).toBe(true);
    const sent = fake.calls.find((c) => c.method === 'POST' && /\/messages$/.test(c.path));
    expect(sent?.body).toMatchObject({ text: 'What is entropy?', mentions: [], quotes: [], attachments: [] });
    expect(input).toHaveTextContent('');
  });

  it('an interrupted answer says why and when, and Resume starts it again', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    await within(side()).findByRole('region', { name: 'Pinned' });
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('hit the limit{Enter}');
    const alert = await screen.findByText('Answer interrupted: subscription limit');
    const card = alert.closest('.kb-interrupt') as HTMLElement;
    expect(card).toHaveTextContent('ChatGPT subscription limit reached.');
    expect(card).toHaveTextContent(/The limit resets/);
    await user.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(fake.calls.some((c) => /\/resume$/.test(c.path))).toBe(true));
  });

  it('⋯ menu: export goes through the native save dialog; save to wiki opens the analysis page; delete asks first', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ b2: b2State() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const more = await within(centre).findByRole('button', { name: /More for/ });
    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Export as .md' }));
    await waitFor(() => expect(fake.bridge.saveTextFile).toHaveBeenCalledWith(expect.objectContaining({ suggested_name: 'Why is there a logarithm in the loss?.md' })));
    expect(await within(centre).findByRole('status')).toHaveTextContent('Exported to /Users/me/Downloads/');

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Save to wiki as analysis' }));
    await waitFor(() => expect(services.ui.getState().doc).toMatchObject({ type: 'page', id: 'p-c1' }));

    await user.click(more);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(side()).queryByRole('button', { name: /Why is there a logarithm/ })).not.toBeInTheDocument());
  });

  it('Pin and Rename from the ⋯ menu', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
    await user.click(await within(side()).findByRole('button', { name: /Compare regularisation/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    await user.click(await within(centre).findByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(within(within(side()).getByRole('region', { name: 'Pinned' })).getByRole('button', { name: /Compare regularisation/ })).toBeInTheDocument());
    await user.click(within(centre).getByRole('button', { name: /More for/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = within(centre).getByRole('textbox', { name: 'Chat name' });
    await user.clear(field);
    await user.type(field, 'L1 vs L2{Enter}');
    expect(await within(centre).findByRole('heading', { name: 'L1 vs L2' })).toBeInTheDocument();
  });

  it('"All chats" takes the whole centre: search, filters, folder; a row opens the chat', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
    await user.click(await within(side()).findByRole('button', { name: 'All chats · 7' }));
    const all = screen.getByRole('region', { name: 'All chats' });
    expect(await within(all).findByRole('button', { name: /^Transformer paper review/ })).toBeInTheDocument();
    await user.click(within(all).getByRole('radio', { name: 'Pinned' }));
    await waitFor(() => expect(within(all).queryByRole('button', { name: /^Transformer paper review/ })).not.toBeInTheDocument());
    expect(within(all).getByRole('button', { name: /^Exam preparation for ML/ })).toBeInTheDocument();
    await user.click(within(all).getByRole('radio', { name: 'All' }));
    await user.type(within(all).getByRole('searchbox', { name: 'Find in chats' }), 'regular');
    await waitFor(() => expect(within(all).getAllByRole('button', { name: /^Compare regularisation/ })).toHaveLength(1));
    await user.click(within(all).getByRole('button', { name: /^Compare regularisation/ }));
    expect(await screen.findByRole('heading', { name: 'Compare regularisation approaches' })).toBeInTheDocument();
  });
});

describe('Answer text', () => {
  it('safe Markdown: raw HTML is text, script links and images are not live; chips stay inline', () => {
    render(
      <InlineMarkdown
        pieces={['See <img src=x onerror="alert(1)"> and [bad](javascript:alert(1)) and [ok](https://example.org) ', 0, ' **done** ![pic](https://t.example/x.png)']}
        slot={(i, key) => <button key={key} type="button">chip {i}</button>}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://example.org/');
    expect(screen.getByRole('button', { name: 'chip 0' }).closest('p')).toHaveTextContent('chip 0 done');
  });

  it('parts: text/cite/page flow as one run; a connection is its own block; tools are not text', () => {
    const state = b2State();
    const parts = state.chats.find((c) => c.id === 'c1')!.messages[1]!.parts;
    const blocks = toBlocks(parts);
    expect(blocks.map((b) => b.kind)).toEqual(['inline', 'connection']);
    // Copy keeps the Markdown the agent wrote; chips become their names.
    expect(plainText(parts)).toMatch(/^Cross-entropy is \*\*Shannon entropy\*\* applied to the model’s error Entropy\./);
    expect(plainText(parts)).not.toMatch(/Read page/);
  });
});
