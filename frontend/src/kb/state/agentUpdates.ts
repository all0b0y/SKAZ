import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbAgentUpdate, KbAgentUpdates } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { errorText, type KbClient } from '../api/client';
import type { AgentsStore } from './agents';
import type { ActionResult } from './library';

/**
 * Agent updates (U1): what SKAZ's own checks found (the backend checks ~1 min after start and then
 * daily; reading this asks nothing outside SKAZ), the offer per agent, and the unseen flag for the
 * dot on Settings and Accounts & keys. Read at start and every few minutes while the window is
 * visible; every couple of seconds while an update waits or runs.
 */
export interface AgentUpdatesData {
  view: KbAgentUpdates | null;
  error: string | null;
  /** A button of this agent is on its way. */
  pending: Partial<Record<EngineId, 'update' | 'skip' | 'cancel' | 'rollback'>>;
  checking: boolean;
}

export interface AgentUpdatesActions {
  load: () => Promise<void>;
  setAuto: (on: boolean) => Promise<ActionResult>;
  checkNow: () => Promise<ActionResult>;
  /** Settings → Accounts & keys showed the offers: the dot goes until a newer version appears. */
  markSeen: () => Promise<void>;
  update: (engine: EngineId) => Promise<ActionResult>;
  skip: (engine: EngineId, version: string) => Promise<ActionResult>;
  cancel: (engine: EngineId) => Promise<ActionResult>;
  rollback: (engine: EngineId) => Promise<ActionResult>;
  /** Start reading (returns stop); a second start shares the first one. */
  start: () => () => void;
}

export type AgentUpdatesStore = StoreApi<AgentUpdatesData & AgentUpdatesActions>;

export const SLOW_MS = 5 * 60_000;
export const FAST_MS = 2_000;

export function updateOf(view: KbAgentUpdates | null, engine: EngineId): KbAgentUpdate | undefined {
  return view?.agents.find((a) => a.engine === engine);
}

const active = (view: KbAgentUpdates | null) => !!view && (view.checking || view.agents.some((a) => a.phase !== 'idle'));

export function createAgentUpdatesStore(client: KbClient, agents?: AgentsStore,
  clock: { hidden: () => boolean } = { hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden' }): AgentUpdatesStore {
  return createStore<AgentUpdatesData & AgentUpdatesActions>()((set, get) => {
    let reading: Promise<void> | null = null;
    let starts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** An update started by the backend (now or after current work): the agent card follows its log. */
    const follow = async (view: KbAgentUpdates) => {
      if (!agents) return;
      for (const a of view.agents) {
        if (!a.task_id) continue;
        if (agents.getState().installs[a.engine]?.task.id === a.task_id) continue;
        try {
          const task = await client.call('GET /kb/agents/install/{task_id}', { path: { task_id: a.task_id } });
          agents.setState((s) => ({ installs: { ...s.installs, [a.engine]: { task, lines: task.lines } } }));
        } catch { /* the next read tries again */ }
      }
    };
    const put = (view: KbAgentUpdates) => {
      const before = get().view;
      set({ view, error: null });
      void follow(view);
      // An update that just ended: the agent's own status is read again (version, state).
      for (const a of before?.agents ?? []) {
        const now = updateOf(view, a.engine);
        if (a.phase !== 'idle' && now?.phase === 'idle') void agents?.getState().check(a.engine);
      }
      schedule();
    };
    const schedule = () => {
      if (starts === 0) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!clock.hidden() || active(get().view)) void get().load(); else schedule(); },
        active(get().view) ? FAST_MS : SLOW_MS);
    };
    const act = async (engine: EngineId, what: AgentUpdatesData['pending'][EngineId] & string, call: () => Promise<KbAgentUpdates>): Promise<ActionResult> => {
      set((s) => ({ pending: { ...s.pending, [engine]: what } }));
      try {
        put(await call());
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      } finally {
        set((s) => { const { [engine]: _done, ...rest } = s.pending; return { pending: rest }; });
      }
    };
    return {
      view: null,
      error: null,
      pending: {},
      checking: false,

      load: () => {
        reading ??= (async () => {
          try {
            put(await client.call('GET /kb/agents/updates'));
          } catch (error) {
            set({ error: errorText(error) });
            schedule();
          } finally {
            reading = null;
          }
        })();
        return reading;
      },

      setAuto: async (on) => {
        try {
          put(await client.call('PUT /kb/agents/updates/settings', { body: { auto: on } }));
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      checkNow: async () => {
        set({ checking: true });
        try {
          put(await client.call('POST /kb/agents/updates/check-now'));
          return { ok: true, value: undefined };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        } finally {
          set({ checking: false });
        }
      },

      markSeen: async () => {
        if (!get().view?.unseen) return;
        try { put(await client.call('POST /kb/agents/updates/seen')); } catch { /* the dot stays; nothing else */ }
      },

      update: (engine) => act(engine, 'update', () => client.call('POST /kb/agents/{engine}/update', { path: { engine } })),
      skip: (engine, version) => act(engine, 'skip', () => client.call('POST /kb/agents/{engine}/update/skip', { path: { engine }, body: { version } })),
      cancel: (engine) => act(engine, 'cancel', () => client.call('POST /kb/agents/{engine}/update/cancel', { path: { engine } })),
      rollback: (engine) => act(engine, 'rollback', () => client.call('POST /kb/agents/{engine}/update/rollback', { path: { engine } })),

      start: () => {
        starts += 1;
        if (starts === 1) void get().load();
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          starts -= 1;
          if (starts === 0 && timer) { clearTimeout(timer); timer = null; }
        };
      },
    };
  });
}
