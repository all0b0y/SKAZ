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
  /** Install/update/first-check logs by engine. */
  installs: Partial<Record<EngineId, InstallView>>;
  /** A check of this agent is on its way (one at a time per agent). */
  checking: Partial<Record<EngineId, boolean>>;
  /** When this window last got a checked status of the agent (ms), for the automatic checks. */
  checkedAt: Partial<Record<EngineId, number>>;
  /** Sign-in started here and finishes outside SKAZ: the next return to the window checks at once. */
  awaitingSignIn: Partial<Record<EngineId, number>>;
}

/** Automatic checks (open, window focus) skip an agent checked less than this long ago. */
export const AUTO_CHECK_MIN_MS = 30_000;
/** How long a started sign-in keeps bypassing that limit. */
export const SIGN_IN_WAIT_MS = 15 * 60_000;
export type AutoCheckReason = 'open' | 'focus';

export interface AgentsActions {
  refresh: () => Promise<void>;
  setDefault: (engine: EngineId) => Promise<ActionResult>;
  install: (engine: EngineId, action?: 'install' | 'update' | 'first_check') => Promise<ActionResult>;
  /** Follow a running task's log; returns stop. */
  followInstall: (engine: EngineId, taskId: string) => () => void;
  cancelInstall: (engine: EngineId) => Promise<ActionResult>;
  login: (engine: EngineId, consent?: boolean) => Promise<ActionResult<KbAgentLoginResult>>;
  /** Check now (the Check button, after install/sign-out); joins a check already on its way. */
  check: (engine: EngineId) => Promise<ActionResult<KbAgent>>;
  /**
   * Check by itself (Settings/agent menu opened, window focused): only a visible window, at most
   * once per AUTO_CHECK_MIN_MS per agent (a started sign-in bypasses it), never during an install.
   */
  autoCheck: (reason: AutoCheckReason, engines?: readonly EngineId[]) => void;
  /** Codex only: sign out of SKAZ's own Codex profile (other Codex apps keep their sign-in). */
  logoutCodex: () => Promise<ActionResult<KbAgent>>;
}

export type AgentsStore = StoreApi<AgentsData & AgentsActions>;

export const ENGINE_ORDER: readonly EngineId[] = ['codex', 'claude_code', 'hermes'];
export const ENGINE_NAME: Record<EngineId, string> = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes Agent' };

const DEFAULT_CLOCK = {
  now: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

export function agentOf(agents: KbAgents | null, engine: EngineId): KbAgent | undefined {
  return agents?.agents.find((a) => a.id === engine);
}

export function createAgentsStore(client: KbClient, clock: { now: () => number; hidden: () => boolean } = DEFAULT_CLOCK): AgentsStore {
  return createStore<AgentsData & AgentsActions>()((set, get) => {
    const inflight = new Map<EngineId, Promise<ActionResult<KbAgent>>>();
    let reading: Promise<void> | null = null;
    const stamped = (engines: readonly EngineId[]) => {
      const at = clock.now();
      return { ...get().checkedAt, ...Object.fromEntries(engines.map((e) => [e, at])) };
    };
    const settle = (agent: KbAgent) => {
      // A sign-in that went through (or a sign-out) ends the wait for it.
      if (agent.signed_in || agent.state === 'ready' || agent.state === 'not_installed') {
        const { [agent.id]: _done, ...rest } = get().awaitingSignIn;
        set({ awaitingSignIn: rest });
      }
    };
    const putAgent = (agent: KbAgent) => {
      const agents = get().agents;
      set({ checkedAt: stamped([agent.id]) });
      settle(agent);
      if (!agents) return;
      set({ agents: { ...agents, agents: agents.agents.map((a) => (a.id === agent.id ? agent : a)) } });
    };
    return {
      agents: null,
      load: 'idle',
      error: null,
      installs: {},
      checking: {},
      checkedAt: {},
      awaitingSignIn: {},

      refresh: () => {
        reading ??= (async () => {
          if (get().load !== 'ready') set({ load: 'loading' });
          try {
            const agents = await client.call('GET /kb/agents');
            set({ agents, load: 'ready', error: null, checkedAt: stamped(agents.agents.map((a) => a.id)) });
            agents.agents.forEach(settle);
          } catch (error) {
            set({ load: get().agents ? 'ready' : 'error', error: errorText(error) });
          } finally {
            reading = null;
          }
        })();
        return reading;
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
        // Installed, updated or first-checked: the agent's status is read again right away.
        if (task.state !== 'running') void get().check(engine);
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
          // The sign-in finishes in the browser/Terminal: coming back to the window checks it.
          set((st) => ({ awaitingSignIn: { ...st.awaitingSignIn, [engine]: clock.now() } }));
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

      check: (engine) => {
        const running = inflight.get(engine);
        if (running) return running;
        const done = (async (): Promise<ActionResult<KbAgent>> => {
          set((st) => ({ checking: { ...st.checking, [engine]: true } }));
          try {
            const agent = await client.call('POST /kb/agents/{engine}/check', { path: { engine } });
            putAgent(agent);
            return { ok: true, value: agent };
          } catch (error) {
            return { ok: false, error: errorText(error) };
          } finally {
            inflight.delete(engine);
            set((st) => ({ checking: { ...st.checking, [engine]: false } }));
          }
        })();
        inflight.set(engine, done);
        return done;
      },

      autoCheck: (_reason, engines = ENGINE_ORDER) => {
        if (clock.hidden()) return;
        const st = get();
        if (!st.agents) { void st.refresh(); return; }
        if (reading) return; // a full read is on its way: it checks every agent
        const now = clock.now();
        for (const engine of engines) {
          if (st.installs[engine]?.task.state === 'running') continue;
          const signIn = st.awaitingSignIn[engine];
          const waiting = signIn !== undefined && now - signIn < SIGN_IN_WAIT_MS;
          const last = st.checkedAt[engine];
          if (!waiting && last !== undefined && now - last < AUTO_CHECK_MIN_MS) continue;
          void get().check(engine);
        }
      },
    };
  });
}
