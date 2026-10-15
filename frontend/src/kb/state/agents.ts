import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbAgent, KbAgentLoginResult, KbAgents, KbInstallLine, KbInstallTask } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { errorText, type KbClient } from '../api/client';
import type { ActionResult, Load } from './library';
import { longPoll } from './poll';

export interface InstallView {
  task: KbInstallTask;
  /** Every line seen so far (the long poll returns only new ones). */
  lines: KbInstallLine[];
}

export interface AgentsData {
  agents: KbAgents | null;
  load: Load;
  error: string | null;
  /** Install/update/prepare logs by engine. */
  installs: Partial<Record<EngineId, InstallView>>;
}

export interface AgentsActions {
  refresh: () => Promise<void>;
  setDefault: (engine: EngineId) => Promise<ActionResult>;
  install: (engine: EngineId, action?: 'install' | 'update' | 'prepare') => Promise<ActionResult>;
  /** Follow a running task's log; returns stop. */
  followInstall: (engine: EngineId, taskId: string) => () => void;
  cancelInstall: (engine: EngineId) => Promise<ActionResult>;
  login: (engine: EngineId, consent?: boolean) => Promise<ActionResult<KbAgentLoginResult>>;
  check: (engine: EngineId) => Promise<ActionResult<KbAgent>>;
  /** Codex only: sign out of SKAZ's own Codex profile (other Codex apps keep their sign-in). */
  logoutCodex: () => Promise<ActionResult<KbAgent>>;
}

export type AgentsStore = StoreApi<AgentsData & AgentsActions>;

export const ENGINE_ORDER: readonly EngineId[] = ['codex', 'claude_code', 'hermes'];
export const ENGINE_NAME: Record<EngineId, string> = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes Agent' };

export function agentOf(agents: KbAgents | null, engine: EngineId): KbAgent | undefined {
  return agents?.agents.find((a) => a.id === engine);
}

export function createAgentsStore(client: KbClient): AgentsStore {
  return createStore<AgentsData & AgentsActions>()((set, get) => {
    const putAgent = (agent: KbAgent) => {
      const agents = get().agents;
      if (!agents) return;
      set({ agents: { ...agents, agents: agents.agents.map((a) => (a.id === agent.id ? agent : a)) } });
    };
    return {
      agents: null,
      load: 'idle',
      error: null,
      installs: {},

      refresh: async () => {
        if (get().load !== 'ready') set({ load: 'loading' });
        try {
          const agents = await client.call('GET /kb/agents');
          set({ agents, load: 'ready', error: null });
        } catch (error) {
          set({ load: get().agents ? 'ready' : 'error', error: errorText(error) });
        }
      },

      setDefault: async (engine) => {
        try {
          const agents = await client.call('PUT /kb/agents/default', { body: { engine } });
          set({ agents });
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      install: async (engine, action = 'install') => {
        try {
          const task = await client.call('POST /kb/agents/{engine}/install', { path: { engine }, body: { action } });
          set((s) => ({ installs: { ...s.installs, [engine]: { task, lines: task.lines } } }));
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      followInstall: (engine, taskId) => longPoll(async (after, wait) => {
        const task = await client.call('GET /kb/agents/install/{task_id}', { path: { task_id: taskId }, query: { after, wait } });
        const prev = get().installs[engine];
        const seen = new Set((prev?.lines ?? []).map((l) => l.seq));
        const lines = [...(prev?.lines ?? []), ...task.lines.filter((l) => !seen.has(l.seq))];
        set((s) => ({ installs: { ...s.installs, [engine]: { task, lines } } }));
        if (task.state !== 'running') void get().refresh();
        return { cursor: task.cursor, changed: task.lines.length > 0, done: task.state !== 'running' };
      }, 0),

      cancelInstall: async (engine) => {
        const view = get().installs[engine];
        if (!view) return { ok: true, value: undefined };
        try {
          const task = await client.call('POST /kb/agents/install/{task_id}/cancel', { path: { task_id: view.task.id } });
          set((s) => ({ installs: { ...s.installs, [engine]: { task, lines: view.lines } } }));
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      login: async (engine, consent) => {
        try {
          const res = await client.call('POST /kb/agents/{engine}/login', { path: { engine }, body: consent ? { consent: true } : {} });
          return { ok: true, value: res };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      logoutCodex: async () => {
        try {
          const agent = await client.call('POST /kb/agents/codex/logout');
          putAgent(agent);
          return { ok: true, value: agent };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      check: async (engine) => {
        try {
          const agent = await client.call('POST /kb/agents/{engine}/check', { path: { engine } });
          putAgent(agent);
          return { ok: true, value: agent };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },
    };
  });
}
