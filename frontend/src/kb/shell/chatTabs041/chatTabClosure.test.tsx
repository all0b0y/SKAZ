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

async function activityHost({ refusedSend, initialPermission, beforeSwitch, decisionGate }: {
  refusedSend?: ReturnType<typeof deferred<void>>;
  initialPermission?: ReturnType<typeof permissionPart>;
  beforeSwitch?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  decisionGate?: Promise<void>;
} = {}) {
  const user = userEvent.setup();
  const world = streamedWorld();
  if (initialPermission) world.chats.find((chat) => chat.id === 'c2')!.messages[0]!.parts.push(initialPermission);
  const fake = createFakeBridge(world);
  const decisionCalls: BridgeRequest[] = [];
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
      if (req.method === 'POST' && req.path.endsWith('/decide')) {
        decisionCalls.push(req);
        if (decisionGate) await decisionGate;
      }
      return fake.bridge.request<T>(req);
    },
  } });
  const side = within(screen.getByRole('region', { name: 'Chats' }));
  await user.click(await side.findByRole('button', { name: lecture }));
  const heading = screen.getByRole('heading', { name: lecture });
  expect(within(heading).getByLabelText(initialPermission ? 'Waiting for you' : 'Working')).toBeVisible();
  expect(details.length).toBeGreaterThan(0);
  const stopped = details.at(-1)!;
  await beforeSwitch?.(user);
  await user.click(side.getByRole('button', { name: paper }));
  const track = screen.getByRole('tablist', { name: 'Open chats' });
  Object.defineProperties(track, { clientWidth: { value: 170 }, scrollWidth: { value: 500 } });
  fireEvent.scroll(track);
  const publish = async (patch: Partial<KbChatSummary>) => {
    const summary = services.chats.getState().list.find((c) => c.id === 'c2')!;
    await act(async () => list.resolve({ chats: [{ ...summary, ...patch }], cursor: 12 }));
  };
  return { user, fake, services, details, stopped, publish, decisionCalls };
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

const permissionCard = (title: string) => within(screen.getByRole('region', { name: `Codex wants to edit ${title}` }));
const review = () => within(screen.getByRole('complementary', { name: 'Review' }));
const decisionLabels = ['Deny', 'Allow in this chat', 'Allow'];

it('disables stale permission decisions in the card and open review until detail records cancellation', async () => {
  const pending = permissionPart('cached-edit');
  const { user, services, publish, details, decisionCalls } = await activityHost({
    initialPermission: pending,
    beforeSwitch: async (user) => {
      const card = permissionCard('Entropy');
      expect(card.getByRole('button', { name: 'Allow' })).toBeEnabled();
      await user.click(card.getByRole('button', { name: 'Review beside the chat' }));
    },
  });
  await user.click(review().getByRole('button', { name: 'Deny' }));
  const reason = review().getByRole('textbox', { name: 'Reason for Codex (optional)' });
  await user.type(reason, 'Keep the original');
  expect(reason).toHaveFocus();
  await publish({ state: 'idle', unread: true, waiting_for_user: false });
  expect(review().getByRole('list', { name: 'Changes' })).toBeInTheDocument();
  expect(reason).toBeDisabled();
  expect(review().getByRole('button', { name: 'Send' })).toBeDisabled();
  await user.keyboard('{Enter}');
  fireEvent.submit(reason.closest('form')!);
  expect(decisionCalls).toHaveLength(0);

  await user.click(tab(lecture));
  await user.click(review().getByRole('button', { name: 'Cancel' }));
  const cachedChat = () => services.chats.getState().chats.c2?.chat;
  expect(cachedChat()?.cursor).toBe(1);
  expect(cachedChat()?.messages[0]?.parts).toContainEqual(pending);
  const expectDisabledDecisions = () => {
    for (const surface of [permissionCard('Entropy'), review()]) {
      expect(surface.getByRole('list', { name: 'Changes' })).toBeInTheDocument();
      for (const name of decisionLabels) expect(surface.getByRole('button', { name })).toBeDisabled();
    }
    expect(within(tab(lecture)).queryByLabelText('Waiting for you')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop the answer' })).toBeNull();
  };
  expectDisabledDecisions();
  await act(async () => details.at(-1)!.resolve({ cursor: 2, events: [
    { seq: 2, type: 'state', message_id: 'reply', text: 'done' },
  ] }));
  expect(cachedChat()?.cursor).toBe(2);
  expect(cachedChat()?.messages[0]?.parts).toContainEqual(pending);
  expectDisabledDecisions();
  expect(await services.chats.getState().decide('c2', pending.id, { decision: 'allow' })).toMatchObject({ ok: false });
  expect(decisionCalls).toHaveLength(0);

  const cancelled = { ...pending, status: 'cancelled' as const };
  await act(async () => details.at(-1)!.resolve({ cursor: 3, events: [
    { seq: 3, type: 'part_update', message_id: 'reply', part: cancelled },
  ] }));
  expect(cachedChat()?.cursor).toBe(3);
  expect(cachedChat()?.messages[0]).toMatchObject({ state: 'done', parts: expect.arrayContaining([cancelled]) });
  expect(screen.getAllByRole('group', { name: 'Cancelled: Entropy' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  expect(decisionCalls).toHaveLength(0);
});

it.each(['allow', 'deny'] as const)('sends a current permission %s once across the card and review', async (decision) => {
  const settling = deferred<void>();
  const previous = permissionPart('previous-edit');
  const { user, fake, services, publish, details, decisionCalls } = await activityHost({
    initialPermission: previous, decisionGate: settling.promise,
  });
  await publish({ state: 'answering', waiting_for_user: false });
  await user.click(tab(lecture));
  const decided = { ...previous, status: 'denied' as const, reason: 'Earlier reason' };
  const current = permissionPart('current-edit', { title: 'Cross-entropy' });
  const reply = fake.world.chats.find((chat) => chat.id === 'c2')!.messages[0]!;
  reply.parts = [reply.parts[0]!, decided, current];
  await act(async () => details.at(-1)!.resolve({ cursor: 3, events: [
    { seq: 2, type: 'part_update', message_id: 'reply', part: decided },
    { seq: 3, type: 'part', message_id: 'reply', part: current },
  ] }));
  expect(screen.getByRole('group', { name: 'Denied: Entropy' })).toHaveTextContent('Earlier reason');
  const card = permissionCard('Cross-entropy');
  await user.click(card.getByRole('button', { name: 'Review beside the chat' }));
  await user.click(review().getByRole('button', { name: 'Deny' }));
  const reason = review().getByRole('textbox', { name: 'Reason for Codex (optional)' });
  await user.type(reason, 'Keep the original');
  const allow = card.getByRole('button', { name: 'Allow' });
  if (decision === 'allow') allow.focus();
  await user.keyboard('{Enter}');
  const body = decision === 'deny' ? { decision, reason: 'Keep the original' } : { decision };
  expect(decisionCalls).toMatchObject([{ path: '/kb/permissions/current-edit/decide', body }]);
  expect(allow).toBeDisabled();
  expect(review().getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.submit(reason.closest('form')!);
  await user.click(allow);
  expect(await services.chats.getState().decide('c2', current.id, { decision: 'allow' })).toMatchObject({ ok: false });
  expect(decisionCalls).toHaveLength(1);
  expect(within(tab(lecture)).getByLabelText('Waiting for you')).toBeVisible();
  await act(async () => settling.resolve());
  const outcome = decision === 'deny' ? 'Denied: Cross-entropy' : 'Allowed: Edited Cross-entropy';
  const outcomes = screen.getAllByRole('group', { name: outcome });
  expect(outcomes).toHaveLength(2);
  if (decision === 'deny') for (const result of outcomes) expect(result).toHaveTextContent('Keep the original');
  expect(decisionCalls).toHaveLength(1);
  expect(within(tab(lecture)).queryByLabelText('Waiting for you')).toBeNull();
});

it('shows an optimistic follow-up over the background report and restores its draft on refusal', async () => {
  const refusal = deferred<void>();
  const { user, publish, services } = await activityHost({ refusedSend: refusal });
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
  const chatView = within(screen.getByRole('region', { name: 'Chat' }));
  await user.click(chatView.getByRole('button', { name: /More for “What did I miss/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Close tab' }));
  expect(screen.getByRole('heading', { name: 'New chat' })).toBeVisible();
  await user.click(side.getByRole('button', { name: /All chats/ }));
  const all = within(screen.getByRole('region', { name: 'All chats' }));
  await user.click(await all.findByRole('button', { name: new RegExp('More for “' + deleted) }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Chat deleted.');
  await user.click(all.getByRole('button', { name: 'Back to the chat' }));
  expect(services.chats.getState().closedTabHistory).toEqual([retained]);
  await user.click(side.getByRole('button', { name: title }));
  expect(screen.getByRole('heading', { name: title })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent(draft);
});
