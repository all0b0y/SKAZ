import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { BridgeRequest } from '../../../api/bridge';
import type { KbChatEvent, KbChatSummary } from '../../../api/kb/types.gen';
import { chatMessage } from '../../test/fakeKb';
import { createFakeBridge } from '../../test/fakeBridge';
import { chatWorld, permissionPart } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function streamedWorld() {
  const world = chatWorld();
  const chat = world.chats.find((c) => c.id === 'c2')!;
  chat.messages = [chatMessage('reply', 1, 'assistant', chat.created_at, [
    { type: 'text', text: 'First partial' },
  ], { state: 'streaming' })];
  chat.state = 'answering';
  chat.cursor = 1;
  return world;
}

const lecture = /What did I miss in lecture 8/;
const paper = /Transformer paper review/;
const tab = (name: RegExp) => screen.getByRole('tab', { name });

async function activityHost(refusedSend?: ReturnType<typeof deferred<void>>) {
  const user = userEvent.setup();
  const fake = createFakeBridge(streamedWorld());
  const list = deferred<{ chats: KbChatSummary[]; cursor: number }>();
  const details: ReturnType<typeof deferred<{ events: KbChatEvent[]; cursor: number }>>[] = [];
  let listCount = 0;
  const { services } = renderKb({ bridge: {
    ...fake.bridge,
    request: async <T,>(req: BridgeRequest) => {
      if (refusedSend && req.method === 'POST' && req.path === '/kb/chats/c2/messages') {
        await refusedSend.promise;
        return { ok: false as const, status: 409, detail: 'Fixture refused this send' };
      }
      if (req.path === '/kb/chats/c2/events') {
        const step = deferred<{ events: KbChatEvent[]; cursor: number }>();
        details.push(step);
        return { ok: true as const, status: 200, data: await step.promise as T };
      }
      if (req.path === '/kb/chats/events') {
        if (listCount++) return new Promise<never>(() => {});
        return { ok: true as const, status: 200, data: await list.promise as T };
      }
      return fake.bridge.request<T>(req);
    },
  } });
  const side = within(screen.getByRole('region', { name: 'Chats' }));
  await user.click(await side.findByRole('button', { name: lecture }));
  expect(within(tab(lecture)).getByLabelText('Working')).toBeVisible();
  expect(details.length).toBeGreaterThan(0);
  const stopped = details.at(-1)!;
  await user.click(side.getByRole('button', { name: paper }));
  const track = screen.getByRole('tablist', { name: 'Open chats' });
  Object.defineProperties(track, { clientWidth: { value: 170 }, scrollWidth: { value: 500 } });
  fireEvent.scroll(track);
  const publish = async (patch: Partial<KbChatSummary>) => {
    const summary = services.chats.getState().list.find((c) => c.id === 'c2')!;
    await act(async () => list.resolve({ chats: [{ ...summary, ...patch }], cursor: 12 }));
  };
  return { user, fake, services, details, stopped, publish };
}

it('ignores the stopped follower after the inactive completion reaches the strip and overflow', async () => {
  const { user, services, stopped, publish } = await activityHost();
  await publish({ state: 'idle', unread: true });
  await act(async () => stopped.resolve({
    cursor: 2, events: [{ seq: 2, type: 'delta', message_id: 'reply', text: ' late partial' }],
  }));
  expect(services.chats.getState().list.find((c) => c.id === 'c2')).toMatchObject({ state: 'idle', unread: true });
  expect(services.chats.getState().chats.c2?.chat?.cursor).toBe(1);
  expect(within(tab(lecture)).getByLabelText('New answer')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Open tabs' }));
  await waitFor(() => expect(within(screen.getByRole('menuitem', { name: lecture })).getByText('New')).toBeVisible());
  expect(services.chats.getState().currentId).toBe('c6');
});

it('keeps completed status on reactivation until current detail catches up, then shows a new pending permission', async () => {
  const { user, details, publish, fake } = await activityHost();
  await publish({ state: 'idle', unread: true });
  await user.click(tab(lecture));
  expect(tab(lecture)).toHaveFocus();
  expect(within(tab(lecture)).queryByLabelText('Working')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop the answer' })).toBeNull();
  const cached = fake.world.chats.find((c) => c.id === 'c2')!.messages[0]!;
  await act(async () => details.at(-1)!.resolve({ cursor: 2, events: [
    { seq: 2, type: 'message', message_id: 'reply', message: { ...cached, parts: [{ type: 'text', text: 'More cached text' }] } },
  ] }));
  expect(screen.getByRole('log')).toHaveTextContent('More cached text');
  expect(within(tab(lecture)).queryByLabelText('Working')).toBeNull();
  const text = screen.getByRole('textbox', { name: 'Message' });
  await user.type(text, 'Unsent draft');
  expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled', 'true');
  const next = chatMessage('next', 2, 'assistant', '2026-10-15T09:00:00Z', [permissionPart('ask')], { state: 'streaming' });
  await act(async () => details.at(-1)!.resolve({ cursor: 4, events: [
    { seq: 3, type: 'state', message_id: 'reply', text: 'done' },
    { seq: 4, type: 'message', message_id: 'next', message: next },
  ] }));
  expect(within(tab(lecture)).getByLabelText('Waiting for you')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop the answer' })).toBeVisible();
  expect(text).toHaveTextContent('Unsent draft');
  expect(fake.calls.some((c) => c.path.includes('/decide') || c.path.includes('/stop'))).toBe(false);
});

it('keeps a real followed stream across reselection after a lagging foreground list update', async () => {
  const { user, services, publish } = await activityHost();
  await user.click(tab(lecture));
  await publish({ state: 'idle', unread: false });
  expect(services.chats.getState().list.find((c) => c.id === 'c2')?.state).toBe('idle');
  await user.click(tab(paper));
  await user.click(tab(lecture));
  expect(within(tab(lecture)).getByLabelText('Working')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop the answer' })).toBeVisible();
});

it('keeps a background waiting indication until detail provides the permission the user can deny', async () => {
  const { user, publish, details, fake } = await activityHost();
  const part = permissionPart('permission-1');
  fake.world.chats.find((c) => c.id === 'c2')!.messages[0]!.parts.push(part);
  await publish({ state: 'answering', waiting_for_user: true });
  await user.click(tab(lecture));
  expect(within(tab(lecture)).getByLabelText('Waiting for you')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  await act(async () => details.at(-1)!.resolve({ cursor: 2, events: [
    { seq: 2, type: 'part', message_id: 'reply', part },
  ] }));
  const card = within(screen.getByRole('region', { name: 'Codex wants to edit Entropy' }));
  expect(fake.calls.filter((c) => c.path.endsWith('/decide'))).toHaveLength(0);
  await user.click(card.getByRole('button', { name: 'Deny' }));
  await user.type(card.getByRole('textbox', { name: 'Reason for Codex (optional)' }), 'Keep original{Enter}');
  const decisions = fake.calls.filter((c) => c.path.endsWith('/decide'));
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ path: '/kb/permissions/permission-1/decide', body: { decision: 'deny', reason: 'Keep original' } });
  expect(within(tab(lecture)).queryByLabelText('Waiting for you')).toBeNull();
});

it('shows an optimistic follow-up over the background report and restores its draft on refusal', async () => {
  const refusal = deferred<void>();
  const { user, publish, services } = await activityHost(refusal);
  await publish({ state: 'idle', unread: true });
  await user.click(tab(lecture));
  const text = screen.getByRole('textbox', { name: 'Message' });
  await user.type(text, 'Keep on refusal{Enter}');
  await waitFor(() => expect(services.chats.getState().chats.c2?.chat?.messages.at(-1)?.id).toMatch(/^local-/));
  expect(within(tab(lecture)).getByLabelText('Working')).toBeVisible();
  await act(async () => refusal.resolve());
  expect(await screen.findByText('Fixture refused this send')).toBeVisible();
  expect(text).toHaveTextContent('Keep on refusal');
  expect(within(tab(lecture)).queryByLabelText('Working')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop the answer' })).toBeNull();
});

it.each([
  { deleted: 'Transformer paper review', retained: 'c2', title: lecture, draft: 'Draft for lecture' },
  { deleted: 'What did I miss in lecture 8', retained: 'c6', title: paper, draft: 'Draft for paper' },
])('preserves the newest eligible closed tab, focus and draft after deleting $deleted in All chats', async ({
  deleted, retained, title, draft,
}) => {
  const user = userEvent.setup();
  const { services } = renderKb({ world: chatWorld() });
  const side = within(screen.getByRole('region', { name: 'Chats' }));
  await user.click(await side.findByRole('button', { name: lecture }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Draft for lecture');
  await user.click(side.getByRole('button', { name: paper }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Draft for paper');
  await user.click(screen.getByRole('button', { name: 'Close tab: Transformer paper review' }));
  await user.click(screen.getByRole('button', { name: /Close tab: What did I miss/ }));
  expect(screen.getByRole('button', { name: 'Reopen last chat' })).toHaveFocus();
  await user.click(side.getByRole('button', { name: /All chats/ }));
  const all = within(screen.getByRole('region', { name: 'All chats' }));
  await user.click(await all.findByRole('button', { name: new RegExp('More for “' + deleted) }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Chat deleted.');
  await user.click(all.getByRole('button', { name: 'Back to the chat' }));
  expect(services.chats.getState().closedTabHistory).toEqual([retained]);
  const reopen = screen.getByRole('button', { name: 'Reopen last chat' });
  await user.click(reopen);
  expect(tab(title)).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent(draft);
});
