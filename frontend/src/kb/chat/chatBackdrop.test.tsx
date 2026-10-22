import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { finishAnswer } from '../test/fakeKb';
import { LEAVE_MS } from './ChatView';

/*
 * CHAT-BACKDROP-SPEC in the chat: the backdrop is behind a chat that has messages only, never with
 * the empty-chat field, decorative and inert, and it «works» exactly while an answer is being written
 * (the same streaming state that shows «Writing an answer…»). jsdom has no canvas: the pixels and the
 * loop are covered by fx/backdrop tests.
 */

const side = () => screen.getByRole('region', { name: 'Chats' });
const centre = () => screen.getByRole('region', { name: 'Chat' });
const stage = () => centre().querySelector('.kb-chat__stage')!;
const backdrop = () => centre().querySelector('.kb-chat__backdrop');
const field = () => centre().querySelector('canvas.kb-fx-field');

/** React's props of a DOM node: what handlers it really has. */
const reactProps = (el: Element): Record<string, unknown> => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  return key ? (el as unknown as Record<string, Record<string, unknown>>)[key]! : {};
};

function holdLeaveTimer(ms: number) {
  const real = window.setTimeout.bind(window);
  const held: Array<() => void> = [];
  vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === ms && typeof fn === 'function') {
      held.push(() => (fn as (...a: unknown[]) => void)(...args));
      return 0;
    }
    return real(fn, delay, ...args);
  }) as typeof window.setTimeout);
  return { end: () => act(() => { held.splice(0).forEach((f) => f()); }) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Chat backdrop', () => {
  it('a chat with messages: the backdrop is behind the thread — decorative, not focusable, no pointer handlers', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    const bd = backdrop()!;
    expect(bd).toBeInTheDocument();
    expect(bd).toHaveAttribute('aria-hidden', 'true');
    const canvas = bd.querySelector('canvas')!;
    expect(canvas).toHaveClass('kb-fx-backdrop');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    // In the stage, under the conversation (before it, outside it): not under header or message field.
    const log = within(centre()).getByRole('log', { name: 'Conversation' });
    expect(bd.parentElement).toBe(stage());
    expect(bd.nextElementSibling).toBe(log);
    expect(log.contains(bd)).toBe(false);
    expect(bd.contains(screen.getByTestId('message-input'))).toBe(false);
    // Inert: nothing to tab to, no handlers on it or its stage, no field state on the stage.
    for (const el of [bd, canvas]) {
      expect(el).not.toHaveAttribute('tabindex');
      expect(Object.keys(reactProps(el)).filter((k) => /^on[A-Z]/.test(k))).toEqual([]);
    }
    expect(Object.keys(reactProps(stage())).filter((k) => /^on[A-Z]/.test(k) && reactProps(stage())[k])).toEqual([]);
    expect(stage()).not.toHaveAttribute('data-fx');
    expect(stage()).not.toHaveAttribute('data-interactive');
    expect(field()).toBeNull();
    expect(bd).not.toHaveAttribute('data-working'); // an answered chat is at rest
  });

  it('no chat, or an empty chat: no backdrop (the empty field is there instead)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    Object.assign(world.chats.find((c) => c.id === 'c3')!, { messages: [] });
    renderKb({ world });
    await within(side()).findByRole('region', { name: 'Pinned' });
    expect(field()).toBeInTheDocument();
    expect(backdrop()).toBeNull();
    await user.click(within(side()).getByRole('button', { name: /Compare regularisation/ }));
    await waitFor(() => expect(centre().querySelector('.kb-chat__plate')).toHaveTextContent('No messages yet'));
    expect(field()).toBeInTheDocument();
    expect(backdrop()).toBeNull();
  });

  it('the first message: never both — the backdrop comes when the burn-out ends, and works while the answer is written', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    const { fake, services } = renderKb({ world });
    await within(side()).findByRole('region', { name: 'Pinned' });
    const leave = holdLeaveTimer(LEAVE_MS);
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('What is entropy?{Enter}');
    await within(centre()).findByRole('article', { name: 'Your question' });
    expect(stage()).toHaveAttribute('data-fx', 'leaving');
    expect(field()).toBeInTheDocument();
    expect(backdrop()).toBeNull();
    leave.end();
    expect(field()).toBeNull();
    expect(backdrop()).toBeInTheDocument();
    // «Writing an answer…» is on screen: the backdrop's energy target is 1.
    expect(within(centre()).getByText('Writing an answer…')).toBeInTheDocument();
    expect(backdrop()).toHaveAttribute('data-working', 'true');
    // The answer is done: target 0.
    const id = services.chats.getState().currentId!;
    finishAnswer(fake.world, id);
    await act(() => services.chats.getState().load(id));
    await waitFor(() => expect(backdrop()).not.toHaveAttribute('data-working'));
    expect(within(centre()).queryByText('Writing an answer…')).toBeNull();
    expect(backdrop()).toBeInTheDocument();
  });

  it('an old chat asked again works while it answers, and the same backdrop stays (no remount)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    const { fake } = renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    const before = backdrop();
    expect(before).not.toHaveAttribute('data-working');
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('And the base of the logarithm?{Enter}');
    await within(centre()).findByText('Writing an answer…');
    expect(backdrop()).toBe(before);
    expect(backdrop()).toHaveAttribute('data-working', 'true');
    expect(fake.world.pendingAnswers.c1).toBeDefined();
  });
});
