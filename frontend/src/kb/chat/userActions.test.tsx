import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { chatMessage, finishAnswer } from '../test/fakeKb';
import { applyEvents } from '../state/chats';

// Chat actions under your own message (2026-10-21, .dev/ui-redesign/chat-actions/actions-v1.html):
// Copy · Edit (in place, later replies redone) · Resend (same question again, at the end).

const side = () => screen.getByRole('region', { name: 'Chats' });
const QUESTION = 'Why is there a logarithm in the loss function?';

async function openC1(world = chatWorld()) {
  const user = userEvent.setup();
  const r = renderKb({ world });
  await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
  const centre = screen.getByRole('region', { name: 'Chat' });
  const question = (await within(centre).findAllByRole('article', { name: 'Your question' }))[0]!;
  return { user, r, centre, question, world };
}

describe('Your message: Copy · Edit · Resend', () => {
  it('has a row of actions named “Message actions”; Copy copies the typed text and says Copied', async () => {
    const { user, question } = await openC1();
    const row = within(question).getByRole('group', { name: 'Message actions' });
    expect(within(row).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy', 'Edit', 'Resend']);
    await user.click(within(row).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(QUESTION);
    expect(within(row).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('Edit turns the bubble into a field; Cancel and Esc keep everything as it was', async () => {
    const { user, r, centre, question } = await openC1();
    await user.click(within(question).getByRole('button', { name: 'Edit' }));
    const field = within(question).getByRole('textbox', { name: 'Edit your question' });
    expect(field).toHaveTextContent(QUESTION);
    expect(field).toHaveFocus();
    expect(question).toHaveTextContent('Answers after this question are removed and it is answered again.');
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(within(question).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(question).getByText(QUESTION)).toBeInTheDocument();
    // Esc cancels too, and the focus goes back to Edit.
    await user.click(within(question).getByRole('button', { name: 'Edit' }));
    await user.keyboard(' and why base e?{Escape}');
    expect(within(question).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(question).getByRole('button', { name: 'Edit' })).toHaveFocus();
    expect(within(centre).getByRole('article', { name: 'Answer' })).toBeInTheDocument();
    expect(r.fake.calls.some((c) => /\/edit$/.test(c.path))).toBe(false);
  });

  it('Send replaces the question, removes the answers after it and answers it again', async () => {
    const world = chatWorld();
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    c1.messages.push(
      chatMessage('c1-u3', 3, 'user', new Date().toISOString(), [{ type: 'text', text: 'And in nats?' }]),
      chatMessage('c1-a4', 4, 'assistant', new Date().toISOString(), [{ type: 'text', text: 'Nats use base e.' }]),
    );
    c1.cursor = 4;
    const { user, r, centre } = await openC1(world);
    const first = within(centre).getAllByRole('article', { name: 'Your question' })[0]!;
    await user.click(within(first).getByRole('button', { name: 'Edit' }));
    const field = within(first).getByRole('textbox', { name: 'Edit your question' });
    expect(field).toHaveFocus(); // the caret waits at the end of the text
    await user.keyboard(' Is it the same as entropy?');
    await user.click(within(first).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(r.fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages/c1-u1/edit')).toBe(true));
    const call = r.fake.calls.find((c) => c.path === '/kb/chats/c1/messages/c1-u1/edit')!;
    expect(call.body).toMatchObject({ text: `${QUESTION} Is it the same as entropy?`, mentions: [], quotes: [], attachments: [] });
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' })).toHaveLength(1));
    expect(within(centre).getByRole('article', { name: 'Your question' })).toHaveTextContent(`${QUESTION} Is it the same as entropy?`);
    expect(within(centre).queryByText('Nats use base e.')).not.toBeInTheDocument();
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Answer' })).toHaveLength(1));
    await waitFor(() => expect(within(centre).getByRole('article', { name: 'Answer' })).toHaveTextContent('Cross-entropy is Shannon entropy'));
  });

  it('Enter sends the edit (the message field’s rule); mentions stay tokens, attachments go along', async () => {
    const world = chatWorld();
    const c1 = world.chats.find((c) => c.id === 'c1')!;
    const u1 = c1.messages[0]!;
    u1.input = { text: 'Compare @Entropy with this', mentions: [{ type: 'page', id: 'p-entropy', title: 'Entropy' }], quotes: [], attachments: ['m5'] };
    u1.parts = [{ type: 'text', text: 'Compare @Entropy with this' }];
    const { user, r, question } = await openC1(world);
    await user.click(within(question).getByRole('button', { name: 'Edit' }));
    const field = within(question).getByRole('textbox', { name: 'Edit your question' });
    expect(within(field).getByLabelText('Reference: Entropy')).toBeInTheDocument();
    await user.keyboard(' please{Enter}');
    await waitFor(() => expect(r.fake.calls.some((c) => /\/c1-u1\/edit$/.test(c.path))).toBe(true));
    const call = r.fake.calls.find((c) => /\/c1-u1\/edit$/.test(c.path))!;
    expect(call.body).toMatchObject({
      text: 'Compare @Entropy with this please', mentions: [{ type: 'page', id: 'p-entropy', title: 'Entropy' }], attachments: ['m5'],
    });
  });

  it('Resend asks the same question again as a new message at the end; nothing above changes', async () => {
    const { user, r, centre, question } = await openC1();
    await user.click(within(question).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' })).toHaveLength(2));
    const sent = r.fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats/c1/messages');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ text: QUESTION, mentions: [], quotes: [], attachments: [] });
    const articles = within(centre).getAllByRole('article');
    expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual(['Your question', 'Answer', 'Your question', 'Answer']);
    expect(articles[2]).toHaveTextContent(QUESTION);
  });

  it('while the chat answers, Edit and Resend wait (aria-disabled, with the reason); Copy works', async () => {
    const world = chatWorld();
    world.hold = true;
    const { user, r, centre, question } = await openC1(world);
    await user.click(within(question).getByRole('button', { name: 'Resend' }));
    await waitFor(() => expect(within(centre).getAllByRole('article', { name: 'Your question' })).toHaveLength(2));
    const row = within(question).getByRole('group', { name: 'Message actions' });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true'));
    expect(within(row).getByRole('button', { name: 'Resend' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(row).getByRole('button', { name: 'Edit' })).toHaveAccessibleDescription('Available when the answer is finished');
    expect(within(row).getByRole('button', { name: 'Copy' })).toBeEnabled();
    // Pressing a waiting Edit opens nothing.
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(within(question).queryByRole('textbox')).not.toBeInTheDocument();
    finishAnswer(r.fake.world, 'c1');
    await act(() => r.services.chats.getState().load('c1')); // what the next poll would bring
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Edit' })).not.toHaveAttribute('aria-disabled'));
  });

  it('a refused edit (the agent is still answering elsewhere, 409) keeps the field and says why', async () => {
    const world = chatWorld();
    world.failures['POST /kb/chats/c1/messages/c1-u1/edit'] = { status: 409, detail: 'The agent is still answering in this chat. Stop it or wait for the answer.' };
    const { user, question } = await openC1(world);
    await user.click(within(question).getByRole('button', { name: 'Edit' }));
    await user.keyboard('!');
    await user.click(within(question).getByRole('button', { name: 'Send' }));
    expect(await within(question).findByRole('alert')).toHaveTextContent('The agent is still answering in this chat.');
    expect(within(question).getByRole('textbox', { name: 'Edit your question' })).toBeInTheDocument();
  });

  it('another window follows: a `removed` event takes the message out of the chat', () => {
    const c1 = structuredClone(chatWorld().chats.find((c) => c.id === 'c1')!);
    const next = applyEvents(c1, [{ seq: c1.cursor + 1, type: 'removed', message_id: 'c1-a1' }]);
    expect(next.messages.map((m) => m.id)).toEqual(['c1-u1']);
    expect(next.cursor).toBe(c1.cursor + 1);
  });
});
