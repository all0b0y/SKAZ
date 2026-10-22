import { createStore, type StoreApi } from 'zustand/vanilla';
import type { KbAgent, KbAgentLoginResult, KbAgents, KbInstallLine, KbInstallTask, KbModelChange } from '../../api/kb/types.gen';
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
  /** Accounts & keys v3: a sign-in started here, followed until it ends, then its result line. */
  signIns: Partial<Record<EngineId, SignInView>>;
}

/** A sign-in started from SKAZ: what to show while it is open and once SKAZ has checked it. */
export interface SignInView {
  state: 'waiting' | 'signed_in' | 'not_signed_in' | 'failed';
  method: 'terminal' | 'browser';
  /** The backend's line while waiting, then SKAZ's result line. */
  message: string;
  /** Codex: the sign-in page the backend returned for this sign-in (opened at once). */
  url: string | null;
}

/** Automatic checks (open, window focus) skip an agent checked less than this long ago. */
export const AUTO_CHECK_MIN_MS = 30_000;
/** How long a started sign-in keeps bypassing that limit. */
export const SIGN_IN_WAIT_MS = 15 * 60_000;

/** The result line once SKAZ has checked a finished sign-in (Accounts & keys v3). */
export function signInResult(name: string, method: 'terminal' | 'browser', ended: 'done' | 'failed', agent: KbAgent | null): SignInView {
  if (ended === 'done' && agent?.signed_in) return { state: 'signed_in', method, message: `Signed in. ${name} is connected.`, url: null };
  if (ended === 'done') {
    return { state: 'not_signed_in', method, url: null,
      message: method === 'terminal' ? `${name} finished in Terminal, but it isn’t signed in yet. Try again.` : `${name} isn’t signed in yet. Try again.` };
  }
  return { state: 'failed', method, url: null,
    message: method === 'terminal' ? `${name} stopped before it finished in Terminal. Try again.` : 'The sign-in didn’t finish. Try again.' };
}
export type AutoCheckReason = 'open' | 'focus';

export interface AgentsActions {
  refresh: () => Promise<void>;
  setDefault: (engine: EngineId) => Promise<ActionResult>;
  install: (engine: EngineId, action?: 'install' | 'update' | 'first_check' | 'repair') => Promise<ActionResult>;
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
  /** Sign out in SKAZ's own folder only (Codex, OpenCode); the backend refuses Claude Code and Hermes. */
  logout: (engine: EngineId) => Promise<ActionResult<KbAgent>>;
  /** 0.3.1 K2/K4: show / hide agents, providers and models in the picker; star models. */
  changeModels: (changes: KbModelChange[]) => Promise<ActionResult>;
  /** The backend kept this as the agent's last chat choice (models screen v2): mirror it locally. */
  noteLastChoice: (engine: EngineId, model: string | null, effort: string | null) => void;
}

export type AgentsStore = StoreApi<AgentsData & AgentsActions>;

export const ENGINE_ORDER: readonly EngineId[] = ['codex', 'claude_code', 'hermes', 'opencode'];
export const ENGINE_NAME: Record<EngineId, string> = {
  codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes Agent', opencode: 'OpenCode',
};

const DEFAULT_CLOCK = {
  now: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

export function agentOf(agents: KbAgents | null, engine: EngineId): KbAgent | undefined {
  return agents?.agents.find((a) => a.id === engine);
}

/**
 * Where the message field starts for `engine` (models screen v2): the model and reasoning last
 * chosen for it, while the agent still lists that model; else the agent's own current model.
 */
export function startingChoice(agents: KbAgents, engine: EngineId): { engine: EngineId; model: string | null; effort: string | null } {
  const a = agentOf(agents, engine);
  const last = a?.last_choice;
  if (last && (last.model === null || a?.models.some((m) => m.id === last.model))) {
    const m = a?.models.find((x) => x.id === last.model);
    const effort = last.effort && m?.efforts.includes(last.effort) ? last.effort : m?.default_effort ?? null;
    return { engine, model: last.model, effort };
  }
  const model = a?.models.find((m) => m.id === a.current_model) ?? a?.models[0];
  return { engine, model: model?.id ?? null, effort: model?.default_effort ?? null };
}

/** The picker as it will look after `changes` (the backend's answer replaces it). */
function optimistic(agents: KbAgents, changes: KbModelChange[]): KbAgents {
  const next = structuredClone(agents);
  for (const c of changes) {
    const a = next.agents.find((x) => x.id === c.engine);
    if (!a) continue;
    const value = c.value ?? true;
    if (c.kind === 'agent') a.visible = value;
    else if (c.kind === 'provider') { const p = a.providers.find((x) => x.id === c.provider); if (p) p.visible = value; }
    else if (c.kind === 'model') { const m = a.models.find((x) => x.id === c.model); if (m) m.visible = value; }
    else if (c.kind === 'favorite') {
      next.favorites = next.favorites.filter((f) => !(f.engine === c.engine && f.model === c.model));
      if (value && c.model) next.favorites.push({ engine: c.engine, model: c.model });
      const m = a.models.find((x) => x.id === c.model); if (m) m.favorite = value;
    } else {
      a.models.filter((m) => !c.provider || m.provider === c.provider)
        .forEach((m) => { m.visible = c.kind === 'defaults' ? m.default_visible : false; });
    }
  }
  return next;
}

export function createAgentsStore(client: KbClient, clock: { now: () => number; hidden: () => boolean } = DEFAULT_CLOCK): AgentsStore {
  return createStore<AgentsData & AgentsActions>()((set, get) => {
    const inflight = new Map<EngineId, Promise<ActionResult<KbAgent>>>();
    const following = new Map<EngineId, () => void>();
    const putSignIn = (engine: EngineId, view: SignInView | null) => set((st) => {
      const { [engine]: _old, ...rest } = st.signIns;
      return { signIns: view ? { ...rest, [engine]: view } : rest };
    });
    /** Follow a started sign-in on the backend (no agent command runs there) and check as soon as it ends. */
    const follow = (engine: EngineId, method: 'terminal' | 'browser') => {
      following.get(engine)?.();
      const started = clock.now();
      const stop = longPoll<null>(async (_cursor, wait) => {
        if (clock.now() - started > SIGN_IN_WAIT_MS) { putSignIn(engine, null); return { cursor: null, changed: false, done: true }; }
        const view = await client.call('GET /kb/agents/{engine}/sign-in', { path: { engine }, query: { wait } });
        if (view.state === 'waiting') return { cursor: null, changed: false };
        following.delete(engine);
        if (view.state === 'idle') { putSignIn(engine, null); return { cursor: null, changed: false, done: true }; }
        const checked = await get().check(engine);
        const name = ENGINE_NAME[engine];
        putSignIn(engine, signInResult(name, method, view.state, checked.ok ? checked.value : null));
        return { cursor: null, changed: true, done: true };
      }, null);
      following.set(engine, stop);
    };
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
      signIns: {},

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
          // The sign-in finishes in the browser/Terminal: SKAZ follows it and checks as soon as it ends;
          // coming back to the window checks it too.
          set((st) => ({ awaitingSignIn: { ...st.awaitingSignIn, [engine]: clock.now() } }));
          putSignIn(engine, { state: 'waiting', method: res.method, message: res.message, url: res.url });
          follow(engine, res.method);
          return { ok: true, value: res };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },

      changeModels: async (changes) => {
        // Shown at once: a star or a check box answers the click, then the backend's answer wins.
        const before = get().agents;
        if (before) set({ agents: optimistic(before, changes) });
        try {
          const agents = await client.call('PATCH /kb/agents/models', { body: { changes } });
          set({ agents });
          return { ok: true, value: undefined };
        } catch (error) {
          if (before) set({ agents: before });
          return { ok: false, error: errorText(error) };
        }
      },

      noteLastChoice: (engine, model, effort) => {
        const agents = get().agents;
        if (!agents) return;
        set({ agents: { ...agents, agents: agents.agents.map((a) => (a.id === engine ? { ...a, last_choice: { model, effort } } : a)) } });
      },
      logout: async (engine) => {
        try {
          const agent = await client.call('POST /kb/agents/{engine}/logout', { path: { engine } });
          putAgent(agent);
          putSignIn(engine, null);
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
          if (!st.agents.agents.some((a) => a.id === engine)) continue; // an agent this backend doesn't list
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
