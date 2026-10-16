import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssistantPanel } from './AssistantPanel';
import { CodexTaskCard } from './CodexTaskCard';
import { useStore } from '../../state/store';
import { stopCodexPolling, useCodex } from '../../state/codex';
import { fakeCodex, type FakeCodex } from '../../test/codexFake';
import type { AgentView, CodexTask } from '../../api/codex';
import type { BridgeApi } from '../../api/bridge';
import type { Session } from '../../api/types';

// API providers in agent mode (issue #11) use the agent chat — chats, queue,
// stop and resume — against the authored contract fixture. No model is called.

const initialCodex = useCodex.getState();
const originalBridge = window.skaz;
const sessions: Session[] = [
  { id: 's1', title: 'Lecture', created_at: 't', status: 'stopped', duration_ms: 1000, mode: 'legacy' },
];

let fake: FakeCodex;
const install = (bridge: BridgeApi) => {
  Object.defineProperty(window, 'skaz', { configurable: true, writable: true, value: bridge });
};

const agentView = (available: boolean, reason: string | null = null): AgentView => ({
  assistant: { engine: 'api_agent', api_agent: { provider: 'openai', model: 'gpt-4.1', available, reason } },
  notes: { engine: 'api', api_agent: { provider: 'openai', model: 'gpt-4.1', available, reason } },
});

beforeEach(() => {
  useCodex.setState(initialCodex, true);
  fake = fakeCodex();
  fake.settings = { ...fake.settings, assistant_enabled: false, notes_enabled: false, assistant_api_agent: true };
  // Codex itself is not even installed: agent mode must not depend on it.
  fake.connection = { ...fake.connection, status: 'missing', models: [] };
  install(fake.bridge);
  useStore.setState({
    ready: true, activeSessionId: 's1', sessions, askContext: null, asking: false, askError: null,
    chatScope: 'session', detail: { segments: [], messages: [], notes: null, notes_list: [] },
  });
});

afterEach(() => {
  stopCodexPolling();
  install(originalBridge);
});

describe('Assistant in API agent mode', () => {
  it('uses the agent chat and sends through the queue, never the one-pass ask', async () => {
    fake.agent = agentView(true);
    const ask = vi.fn();
    act(() => useStore.setState({ ask }));
    const user = userEvent.setup();
    render(<AssistantPanel onCite={vi.fn()} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Assistant' })).toHaveAttribute('data-engine', 'api_agent'));
    const box = screen.getByRole('textbox', { name: 'Question' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'Summarise the whole lecture');
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(fake.tasks).toHaveLength(1));
    expect(fake.calls.some((c) => c.method === 'POST' && /\/codex\/chats\/[^/]+\/messages$/.test(c.path))).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    // No Codex connection notice for an engine that does not use Codex.
    expect(screen.queryByText(/Codex was not found/)).not.toBeInTheDocument();
  });

  it('says why agent mode cannot run and sends nothing', async () => {
    fake.agent = agentView(false, "SKAZ cannot confirm that OpenAI 'my-model' supports function calling.");
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<AssistantPanel onCite={vi.fn()} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/cannot confirm that OpenAI 'my-model' supports function calling/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Question' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open Assistant settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('an API-provider task that ended in an error', () => {
  const task = (patch: Partial<CodexTask>): CodexTask => ({
    id: 't1', chat_id: 'c1', session_ids: ['s1'], question: 'Q', model: 'gpt-4.1', status: 'paused',
    snapshot_id: null, answer: '', error: 'openai: the stored API key was rejected.', kind: 'chat',
    note_id: null, citations: [], activity: [], engine: 'api', provider: 'openai', ...patch,
  });

  it('offers Retry and Choose another model', async () => {
    const onResume = vi.fn();
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(<ul><CodexTaskCard task={task({})} activeSessionId="s1" readOnly={false} onCite={vi.fn()}
      onStop={vi.fn()} onResume={onResume} onOpenSettings={onOpenSettings} /></ul>);
    expect(screen.getByRole('alert')).toHaveTextContent('API key was rejected');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onResume).toHaveBeenCalledWith('t1');
    await user.click(screen.getByRole('button', { name: 'Choose another model' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('does not offer to resume a refusal over budget', () => {
    render(<ul><CodexTaskCard task={task({ status: 'failed', error: 'The request used all 128 tool calls.' })}
      activeSessionId="s1" readOnly={false} onCite={vi.fn()} onStop={vi.fn()} onResume={vi.fn()}
      onOpenSettings={vi.fn()} /></ul>);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another model' })).toBeInTheDocument();
  });
});
