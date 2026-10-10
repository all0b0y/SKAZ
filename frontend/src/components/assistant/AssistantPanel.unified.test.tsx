import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';
import { stopCodexPolling, useCodex } from '../../state/codex';
import { fakeCodex, type FakeCodex } from '../../test/codexFake';
import type { BridgeApi } from '../../api/bridge';
import type { Citation, Session } from '../../api/types';

// One visual shell for both Assistant engines, against the authored Codex
// contract fixture (src/test/codexFake.ts). The API engine keeps its own
// single per-session conversation and store.ask; nothing here calls a model.

const initialCodex = useCodex.getState();
const initialAsk = useStore.getState().ask;
const originalBridge = window.skaz;
const sessions: Session[] = [
  { id: 's1', title: 'Лекция 1', created_at: 't', status: 'stopped', duration_ms: 1000, mode: 'legacy' },
];
const citation: Citation = { segment_id: 'seg-7', start_ms: 65_000, end_ms: 70_000, text: 'Бюджет фиксируем.', labels: ['P1'] };

let fake: FakeCodex;
const install = (bridge: BridgeApi) => {
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true, value: bridge });
};

beforeEach(() => {
  useCodex.setState(initialCodex, true);
  fake = fakeCodex();
  install(fake.bridge);
  useStore.setState({
    ready: true, activeSessionId: 's1', sessions, askContext: null, asking: false, askError: null,
    chatScope: 'session', ask: initialAsk,
    detail: { segments: [], messages: [], notes: null, notes_list: [] },
  });
});

afterEach(() => {
  stopCodexPolling();
  install(originalBridge);
  act(() => useStore.setState({ ask: initialAsk }));
});

async function renderAs(engine: 'codex' | 'api') {
  if (engine === 'api') fake.settings.assistant_enabled = false;
  const onCite = vi.fn();
  render(<AssistantPanel onCite={onCite} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(useCodex.getState().availability).toBe('available'));
  await screen.findByRole('textbox', { name: 'Question' });
  return { onCite };
}

/** What the user sees of the panel skeleton, engine-independent. */
function shell() {
  const panel = screen.getByRole('region', { name: 'Assistant' });
  const head = panel.querySelector('header')!;
  const form = panel.querySelector('form')!;
  return { panel, head, form };
}

describe('one Assistant appearance for every engine', () => {
  it.each(['codex', 'api'] as const)('%s: header carries title and scope; composer holds only the question and Send', async (engine) => {
    await renderAs(engine);
    const { panel, head, form } = shell();
    expect(panel).toHaveClass('assistant', 'assistant--chat');
    expect(head).toHaveClass('assistant__head', 'codex-head');
    expect(head.querySelector('.codex-head__scope')).toHaveTextContent('Session');
    expect(panel.querySelector('.assistant__thread')).not.toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Question' })).toHaveAttribute('placeholder', 'Ask about your recordings…');
    expect(within(form).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Send question']);
    // The old separate look is gone: no «Спросить о записях» title bar, no scope inside the composer.
    expect(screen.queryByRole('heading', { name: 'Ask about your recordings' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-figure')).not.toBeInTheDocument();
    expect(panel.querySelector('.assistant__thread--empty')).not.toBeNull();
    expect(panel.querySelector('.assistant__hint--overlay')).not.toBeNull();
    if (engine === 'api') expect(screen.getByText('Ask about your recordings — answers cite the transcript.')).toBeInTheDocument();
  });

  it('codex and api differ only by what the engine supports', async () => {
    await renderAs('codex');
    expect(shell().panel).toHaveAttribute('data-engine', 'codex');
    expect(screen.getByRole('button', { name: 'New chat' })).toHaveAttribute('aria-haspopup', 'true');
  });
});

describe('API engine in the shared shell', () => {
  it('shows the one stored session conversation honestly, without chats, queue, stop or resume', async () => {
    useStore.setState({ detail: { segments: [], notes: null, notes_list: [], messages: [
      { id: 'u', role: 'user', content: 'Что решили?', created_at: 't' },
      { id: 'a', role: 'assistant', content: 'Бюджет — 10 млн [P1].', created_at: 't', citations: [citation] },
    ] } });
    const { onCite } = await renderAs('api');
    const { panel, head } = shell();
    expect(panel).toHaveAttribute('data-engine', 'api');
    expect(within(head).getByText('Session chat')).toBeInTheDocument();
    expect(within(head).queryByRole('button', { name: 'Session chat' })).not.toBeInTheDocument();
    expect(within(head).queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Queue/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop|Continue|Cancel/ })).not.toBeInTheDocument();
    expect(screen.getByText('Что решили?')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Source 1/ }));
    expect(onCite).toHaveBeenCalledWith(citation);
    // No Codex chat was read or created for the API conversation.
    expect(fake.calls.filter((c) => c.path !== '/codex/state')).toEqual([]);
  });

  it('sends through the existing store.ask with the chosen scope and quoted note, never through Codex', async () => {
    const ask = vi.fn(async () => undefined);
    useStore.setState({ ask, askContext: { text: 'Бюджет 10.', citation } });
    await renderAs('api');
    const user = userEvent.setup();
    await user.click(within(shell().head).getByRole('button', { name: 'Search · Session' }));
    await user.click(screen.getByRole('button', { name: 'Group' }));
    expect(useStore.getState().chatScope).toBe('group');
    expect(within(shell().head).getByRole('button', { name: 'Search · Group' })).toBeInTheDocument();
    expect(screen.getByTestId('ask-context')).toHaveTextContent('Бюджет 10.');
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Почему?{Enter}');
    expect(ask).toHaveBeenCalledWith('[Notes fragment, 01:05]\nБюджет 10.\n\nПочему?');
    await waitFor(() => expect(screen.queryByTestId('ask-context')).not.toBeInTheDocument());
    expect(fake.calls.some((c) => c.path.startsWith('/codex/chats'))).toBe(false);
  });

  it('shows the pending answer and keeps scope locked while the API answers', async () => {
    useStore.setState({ asking: true, detail: { segments: [], notes: null, notes_list: [], messages: [
      { id: 'u', role: 'user', content: 'Вопрос в пути', created_at: 't' },
    ] } });
    fake.settings.assistant_enabled = false;
    render(<AssistantPanel onCite={vi.fn()} />);
    await waitFor(() => expect(useCodex.getState().availability).toBe('available'));
    expect(await screen.findByLabelText('Thinking')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(within(shell().head).getByRole('button', { name: 'Search · Session' }));
    expect(screen.getByRole('button', { name: 'Group' })).toBeDisabled();
  });

  it('shows an API failure in the shared error slot and keeps the question', async () => {
    const ask = vi.fn(async () => { useStore.setState({ askError: 'Provider rejected the request' }); });
    useStore.setState({ ask });
    await renderAs('api');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Где итог?{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider rejected the request');
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Где итог?');
  });

  it('uses the API engine in the same shell when the backend does not serve Codex', async () => {
    install({ ...fake.bridge, request: vi.fn(async () => ({ ok: false, status: 404, detail: 'Not Found' })) } as BridgeApi);
    render(<AssistantPanel onCite={vi.fn()} />);
    await waitFor(() => expect(useCodex.getState().availability).toBe('unavailable'));
    expect(shell().panel).toHaveAttribute('data-engine', 'api');
    expect(within(shell().head).getByRole('button', { name: 'Search · Session' })).toBeInTheDocument();
  });
});

describe('engine not yet known', () => {
  it('says it is loading and accepts no question until the engine is known', async () => {
    const ask = vi.fn(async () => undefined);
    useStore.setState({ ask });
    install({ ...fake.bridge, request: vi.fn(() => new Promise(() => undefined)) } as unknown as BridgeApi);
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(shell().panel).toHaveAttribute('data-engine', 'pending');
    expect(screen.getByRole('status')).toHaveTextContent('Loading the assistant…');
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Search/ })).not.toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });

  it('shows the read failure in the same shell with retry and a disabled composer', async () => {
    install({ ...fake.bridge, request: vi.fn(async () => ({ ok: false, status: 500, detail: 'boom' })) } as BridgeApi);
    render(<AssistantPanel onCite={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the Codex status: boom');
    expect(shell().head).toHaveClass('codex-head');
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    install(fake.bridge);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(shell().panel).toHaveAttribute('data-engine', 'codex'));
  });
});
