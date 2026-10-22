// Agent status checked by itself (X6 part 3): dedupe of in-flight checks, the 30 s throttle of the
// automatic checks (window focus, screens opening), sign-in/install follow-ups, hidden window.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAgent, KbAgents } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import type { EngineId } from '../api/names';
import { AUTO_CHECK_MIN_MS, createAgentsStore } from './agents';
import { checkedText } from '../settings/AgentCard';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

const agent = (id: EngineId, extra: Partial<KbAgent> = {}): KbAgent => ({
  id, name: id, installed: true, signed_in: true, version: '1.0.0', state: 'ready', action: null, reason: null,
  models: [], current_model: null, install: { manual_command: '', docs_url: '', checked_on: '' }, install_task: null,
  checked_at: new Date().toISOString(), first_run: null, ...extra,
} as unknown as KbAgent);

/** A client whose answers the test releases by hand; counts the requests per route. */
function fakeClient() {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  // A backend that lists three agents: the store checks only the agents it lists.
  const state: Partial<Record<EngineId, KbAgent>> = { codex: agent('codex'), claude_code: agent('claude_code'), hermes: agent('hermes') };
  const call = vi.fn(async (route: string, options?: { path?: { engine?: EngineId; task_id?: string } }) => {
    const engine = options?.path?.engine;
    calls.push(engine ? `${route}:${engine}` : route);
    await new Promise<void>((resolve) => pending.push(resolve));
    if (route === 'GET /kb/agents') return { agents: Object.values(state) as KbAgent[], default: 'codex', favorites: [] } satisfies KbAgents;
    if (route === 'POST /kb/agents/{engine}/check') return state[engine!];
    if (route === 'POST /kb/agents/{engine}/login') return { engine, method: 'browser', url: 'https://example.org', message: 'Finish in the browser.' };
    if (route === 'GET /kb/agents/install/{task_id}') {
      return { id: options!.path!.task_id, engine: 'hermes', action: 'install', state: 'succeeded', lines: [], cursor: 0, dropped: 0 };
    }
    throw new Error(`unexpected ${route}`);
  });
  const release = async () => {
    while (pending.length) {
      pending.splice(0).forEach((r) => r());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
  };
  return { client: { call } as unknown as KbClient, calls, release, state };
}

function storeAt(start = 1_000_000) {
  let now = start;
  let hidden = false;
  const fake = fakeClient();
  const store = createAgentsStore(fake.client, { now: () => now, hidden: () => hidden });
  return {
    ...fake, store,
    advance: (ms: number) => { now += ms; },
    hide: (value: boolean) => { hidden = value; },
    checks: () => fake.calls.filter((c) => c.startsWith('POST /kb/agents/{engine}/check')),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('Agent checks: dedupe and throttle', () => {
  it('one check in flight per agent: a second Check or an automatic one joins it', async () => {
    const t = storeAt();
    void t.store.getState().refresh();
    await t.release();
    t.advance(AUTO_CHECK_MIN_MS + 1);
    const a = t.store.getState().check('codex');
    const b = t.store.getState().check('codex');
    t.store.getState().autoCheck('focus', ['codex']);
    expect(t.store.getState().checking.codex).toBe(true);
    await t.release();
    expect(await a).toEqual(await b);
    expect(t.checks()).toEqual(['POST /kb/agents/{engine}/check:codex']);
    expect(t.store.getState().checking.codex).toBe(false);
  });

  it('window focus checks each agent at most once per 30 s; Check always goes', async () => {
    const t = storeAt();
    void t.store.getState().refresh(); // the start-up read is a check of all three
    await t.release();
    t.store.getState().autoCheck('focus');
    expect(t.checks()).toHaveLength(0);
    t.advance(AUTO_CHECK_MIN_MS - 1);
    t.store.getState().autoCheck('focus');
    expect(t.checks()).toHaveLength(0);
    t.advance(2);
    t.store.getState().autoCheck('focus');
    await t.release();
    expect(t.checks()).toEqual(['codex', 'claude_code', 'hermes'].map((e) => `POST /kb/agents/{engine}/check:${e}`));
    t.advance(5_000);
    t.store.getState().autoCheck('focus');
    expect(t.checks()).toHaveLength(3);
    void t.store.getState().check('hermes'); // the button forces it
    await t.release();
    expect(t.checks()).toHaveLength(4);
  });

  it('nothing is checked while the window is hidden; screens opening before the first read just read', async () => {
    const t = storeAt();
    t.store.getState().autoCheck('open');
    expect(t.calls).toEqual(['GET /kb/agents']);
    t.store.getState().autoCheck('open'); // the read is on its way: no duplicate
    await t.release();
    expect(t.calls).toEqual(['GET /kb/agents']);
    t.advance(AUTO_CHECK_MIN_MS * 4);
    t.hide(true);
    t.store.getState().autoCheck('focus');
    expect(t.checks()).toHaveLength(0);
  });

  it('after a sign-in starts, coming back checks that agent at once, until it is signed in', async () => {
    const t = storeAt();
    void t.store.getState().refresh();
    await t.release();
    t.state.claude_code = agent('claude_code', { signed_in: false, state: 'signed_out', action: 'login' });
    const login = t.store.getState().login('claude_code');
    await t.release();
    await login;
    t.advance(1_000);
    t.store.getState().autoCheck('focus');
    await t.release();
    expect(t.checks()).toEqual(['POST /kb/agents/{engine}/check:claude_code']); // only the one signing in
    // Still not signed in: the next return checks again; once signed in, the 30 s rule is back.
    t.state.claude_code = agent('claude_code');
    t.advance(1_000);
    t.store.getState().autoCheck('focus');
    await t.release();
    expect(t.checks()).toHaveLength(2);
    t.advance(1_000);
    t.store.getState().autoCheck('focus');
    expect(t.checks()).toHaveLength(2);
  });

  it('a finished install is followed by a check of that agent; no automatic check during an install', async () => {
    const t = storeAt();
    void t.store.getState().refresh();
    await t.release();
    t.store.setState({ installs: { hermes: { task: { id: 't1', state: 'running' } as never, lines: [] } } });
    t.advance(AUTO_CHECK_MIN_MS + 1);
    t.store.getState().autoCheck('focus', ['hermes']);
    expect(t.checks()).toHaveLength(0);
    const stop = t.store.getState().followInstall('hermes', 't1');
    await t.release();
    await waitFor(() => expect(t.checks()).toEqual(['POST /kb/agents/{engine}/check:hermes']));
    stop();
  });
});

describe('Agent checks in the window', () => {
  it('"Checked just now / N min ago"', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(checkedText('2026-10-15T11:59:40Z', now)).toBe('Checked just now');
    expect(checkedText('2026-10-15T11:56:00Z', now)).toBe('Checked 4 min ago');
    expect(checkedText('2026-10-15T09:00:00Z', now)).toBe('Checked 3 h ago');
  });

  it('focus re-checks after 30 s; the agent menu and Settings check when they open; status says when', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-15T12:00:00Z'));
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const checks = () => fake.calls.filter((c) => c.method === 'POST' && /\/kb\/agents\/[^/]+\/check$/.test(c.path)).length;
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'GET' && c.path === '/kb/agents')).toBe(true));
    await screen.findByTestId('agent-picker');
    fireEvent.focus(window);
    expect(checks()).toBe(0); // read at start-up a moment ago
    vi.setSystemTime(Date.now() + AUTO_CHECK_MIN_MS + 1_000);
    fireEvent.focus(window);
    await waitFor(() => expect(checks()).toBe(3));
    fireEvent.focus(window);
    expect(checks()).toBe(3);

    vi.setSystemTime(Date.now() + AUTO_CHECK_MIN_MS + 1_000);
    await user.click(screen.getByTestId('agent-picker'));
    await waitFor(() => expect(checks()).toBe(6));
    await user.keyboard('{Escape}');

    vi.setSystemTime(Date.now() + AUTO_CHECK_MIN_MS + 1_000);
    await user.keyboard('{Meta>},{/Meta}');
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(checks()).toBe(9));
    await user.click(within(within(settings).getByRole('navigation')).getByRole('button', { name: /^Accounts & keys/ }));
    const row = await waitFor(() => {
      const el = settings.querySelector<HTMLElement>('.kb-agentrow[data-engine="codex"]');
      if (!el) throw new Error('no agent row yet');
      return el;
    });
    expect(await within(row).findByText('Checked just now')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Check' })).toBeInTheDocument();
  });
});
