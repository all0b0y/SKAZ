import { describe, expect, it } from 'vitest';
import type { KbAgentUpdates, KbInstallTask } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import { createAgentsStore } from './agents';
import { createAgentUpdatesStore } from './agentUpdates';
import { agentUpdate, emptyAgentUpdates } from '../test/fakeAgentUpdates';

// U1 store: an update the backend starts (now, or after the agent's current work) is followed by the
// agent card's own install log; reading the record asks nothing outside SKAZ.

function client(answers: Record<string, unknown>, calls: string[]): KbClient {
  return { call: async (route: string) => { calls.push(route); if (!(route in answers)) throw new Error(`unexpected ${route}`); return structuredClone(answers[route]); } } as unknown as KbClient;
}

const TASK: KbInstallTask = {
  id: 't9', engine: 'codex', action: 'upgrade', state: 'running', lines: [{ seq: 1, text: '$ codex update', at: '2026-10-26T09:00:00Z' }],
  cursor: 1, dropped: 0, reason: null, version: null,
  install: { docs_url: 'https://developers.openai.com/codex/cli', manual_command: 'x', checked_on: '2026-10-15' },
  started_at: '2026-10-26T09:00:00Z', finished_at: null,
};

describe('agent updates store (U1)', () => {
  it('a queued update that starts is handed to the agent card’s install log', async () => {
    const calls: string[] = [];
    const queued: KbAgentUpdates = { ...emptyAgentUpdates(), agents: [agentUpdate('codex', { available: true, phase: 'queued', action: 'upgrade' })] };
    const started: KbAgentUpdates = { ...emptyAgentUpdates(), agents: [agentUpdate('codex', { available: true, phase: 'updating', action: 'upgrade', task_id: 't9' })] };
    const answers: Record<string, unknown> = { 'GET /kb/agents/updates': queued, 'GET /kb/agents/install/{task_id}': TASK };
    const api = client(answers, calls);
    const agents = createAgentsStore(api);
    const updates = createAgentUpdatesStore(api, agents, { hidden: () => false });
    await updates.getState().load();
    expect(updates.getState().view?.agents[0]?.phase).toBe('queued');
    expect(agents.getState().installs.codex).toBeUndefined();
    answers['GET /kb/agents/updates'] = started;
    await updates.getState().load();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(agents.getState().installs.codex?.task.id).toBe('t9');
    // First snapshot, then one cursor poll owned by the store (no mounted card is needed).
    expect(calls.filter((c) => c === 'GET /kb/agents/install/{task_id}')).toHaveLength(2);
    await updates.getState().load();
    expect(calls.filter((c) => c === 'GET /kb/agents/install/{task_id}')).toHaveLength(2);
    agents.getState().stopMonitoring();
  });

  it('marking seen is sent only when something is unseen', async () => {
    const calls: string[] = [];
    const answers: Record<string, unknown> = { 'GET /kb/agents/updates': emptyAgentUpdates() };
    const updates = createAgentUpdatesStore(client(answers, calls), undefined, { hidden: () => false });
    await updates.getState().load();
    await updates.getState().markSeen();
    expect(calls).toEqual(['GET /kb/agents/updates']);
  });
});
