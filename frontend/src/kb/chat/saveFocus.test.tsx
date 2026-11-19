import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import { chatMessage, serveFake } from '../test/fakeKb';
import { chatWorld, studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';

it.each(['cancel', 'refuse', 'save', 'move focus'] as const)(
  'keeps keyboard focus on the selected wiki action through %s', async (outcome) => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    const chats = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(chats).findByRole('button', { name: /Why is there a logarithm/ }));
    const answer = within(await screen.findByRole('article', { name: 'Answer' }));
    const save = answer.getByRole('button', { name: 'Save to wiki' });
    const original = services.chats.getState().saveMessage;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    services.chats.setState({
      saveMessage: async (...args) => {
        await wait;
        if (outcome === 'save') return original(...args);
        return { ok: false, error: outcome === 'cancel' ? 'Wiki shaping was cancelled.' : 'Shaping failed.' };
      },
      stop: async () => { release(); return { ok: true, value: undefined }; },
    });
    act(() => save.focus());
    await user.keyboard('{Enter}');
    const cancel = answer.getByRole('button', { name: 'Cancel wiki shaping' });
    expect(cancel).toHaveFocus();
    expect(answer.getByRole('button', { name: 'Shaping for wiki…' })).toHaveAttribute('aria-busy', 'true');
    const elsewhere = answer.getByRole('button', { name: 'Copy' });
    if (outcome === 'move focus') act(() => elsewhere.focus());
    if (outcome === 'cancel') await user.keyboard('{Enter}');
    else await act(async () => release());
    const settled = await answer.findByRole('button', { name: outcome === 'save' ? 'Saved to wiki — open' : 'Save to wiki' });
    expect(outcome === 'move focus' ? elsewhere : settled).toHaveFocus();
  },
);

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

it('keeps a newer Study event and the sibling stream after cancelling wiki shaping', async () => {
  const user = userEvent.setup();
  const world = studyWorld();
  const chat = world.chats.find((c) => c.id === 'c12')!;
  const selected = chat.messages.find((m) => m.id === 'c12-a1')!;
  const sibling = chatMessage('c12-stream', selected.seq + 1, 'assistant', selected.created_at,
    [{ type: 'text', text: 'The next answer is still streaming.' }], { state: 'streaming' });
  chat.messages.push(sibling);
  chat.state = 'answering';

  const save = gate();
  const stopStarted = gate();
  const stopResponse = gate();
  const stopReturned = gate();
  const deliverEvents = gate();
  const stopCalls: string[] = [];
  const messagePath = `/kb/chats/${chat.id}/messages/${selected.id}`;
  const request = async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    if (req.method === 'GET' && req.path === `/kb/chats/${chat.id}/events`) await deliverEvents.ready;
    if (req.method === 'POST' && req.path === `${messagePath}/save`) {
      await save.ready;
      return { ok: false, status: 409, code: 'CANCELLED', detail: 'Wiki shaping was cancelled.' };
    }
    if (req.method === 'POST' && req.path === `${messagePath}/stop`) {
      stopCalls.push(req.path);
      const snapshot = structuredClone(selected);
      stopStarted.release();
      save.release();
      await stopResponse.ready;
      stopReturned.release();
      return { ok: true, status: 200, data: snapshot as T };
    }
    return (serveFake(world, req) ?? { ok: false, status: 404, detail: 'Fixture route unavailable' }) as JsonResponse<T>;
  };

  const { services } = renderKb({ world, bridge: { request } });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' }))
    .findByRole('button', { name: /Lecture 8 — cards/ }));
  const deck = within(await screen.findByRole('region', { name: 'Flashcards: Lecture 8' }));
  const progress = deck.getByRole('progressbar', { name: 'Progress' });
  expect(progress).toHaveAttribute('aria-valuenow', '0');
  const chatView = within(screen.getByRole('region', { name: 'Chat' }));
  await user.click(chatView.getByRole('button', { name: 'Save to wiki' }));
  await user.click(chatView.getByRole('button', { name: 'Cancel wiki shaping' }));
  await stopStarted.ready;
  try {
    await user.click(deck.getByText('How did Boltzmann write entropy?'));
    await user.click(deck.getByRole('button', { name: /I know this/ }));
    await deck.findByText('2 left');
    const update = world.chatEvents[chat.id]?.filter((e) => e.type === 'part_update' && e.message_id === selected.id).at(-1);
    expect(update?.part).toMatchObject({ type: 'study', position: 1 });
    deliverEvents.release();
    await waitFor(() => expect(services.chats.getState().chats[chat.id]?.chat?.cursor).toBe(update?.seq));
    expect(progress).toHaveAttribute('aria-valuenow', '1');
  } finally {
    deliverEvents.release();
    await act(async () => { stopResponse.release(); await stopReturned.ready; });
  }
  expect(stopCalls).toEqual([`${messagePath}/stop`]);
  expect(deck.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '1');
  expect(deck.getByText('2 left')).toBeInTheDocument();
  expect(services.chats.getState().chats[chat.id]?.chat?.messages.find((m) => m.id === sibling.id)?.state)
    .toBe('streaming');
});
