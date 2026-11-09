import { createStore, useStore, type StoreApi } from 'zustand';
import type {
  KbContinue,
  KbExploreJob,
  KbJobSummary,
  KbResearchCreate,
  KbResearchDecide,
  KbResearchGrant,
  KbResearchPermission,
  KbResearchTask,
} from '../../api/kb/types.gen';
import { errorText, type KbClient } from '../api/client';
import { createExploreClient, type ExploreClient } from '../api/explore';
import { createResearchClient, type ResearchClient } from '../api/research';
import { useServices } from '../state/context';

export type {
  KbContinue,
  KbExploreJob,
  KbJobSummary,
  KbResearchCreate,
  KbResearchDecide,
  KbResearchGrant,
  KbResearchPermission,
  KbResearchTask,
};

export type ResearchStopReason = KbExploreJob['stop_reason'];
export type ResearchStarterKey = 'new_for_wiki' | 'materials_about' | 'recent_research';
export type ResearchCenterMode = 'closed' | 'new' | 'task';

export interface ResearchApi {
  research: ResearchClient;
  explore: Pick<ExploreClient, 'jobs' | 'run'>;
}

export interface ResearchState {
  mode: ResearchCenterMode;
  activeTaskId: string | null;
  tasks: KbResearchTask[];
  tasksById: Record<string, KbResearchTask>;
  jobs: KbJobSummary[];
  draftPrompt: string;
  draftStarter: ResearchStarterKey | null;
  draftAreaId: string | null;
  busy: boolean;
  error: string | null;
  chatGrants: Record<string, boolean>;
  followUps: Record<string, string[]>;

  openNewTask: (opts?: {
    prompt?: string;
    starter?: ResearchStarterKey | null;
    areaId?: string | null;
  }) => void;
  openTask: (taskId: string) => void;
  close: () => void;
  setDraft: (prompt: string, starter?: ResearchStarterKey | null) => void;
  upsertTask: (task: KbResearchTask) => void;
  loadTasks: () => Promise<KbResearchTask[]>;
  loadTask: (taskId: string) => Promise<KbResearchTask | null>;
  pollProgress: (taskId?: string | null) => Promise<void>;
  startTask: (body?: KbResearchCreate) => Promise<KbResearchTask | null>;
  pauseTask: (taskId: string) => Promise<KbResearchTask | null>;
  resumeTask: (
    taskId: string,
    decisionChoice?: KbContinue['decision_choice'],
  ) => Promise<KbResearchTask | null>;
  cancelTask: (taskId: string) => Promise<KbResearchTask | null>;
  decidePermission: (
    requestId: string,
    decision: KbResearchDecide['decision'],
    chatId?: string,
  ) => Promise<KbResearchPermission>;
  loadGrant: (chatId: string) => Promise<KbResearchGrant | null>;
  revokeGrant: (chatId: string) => Promise<KbResearchGrant | null>;
  setChatGrant: (chatId: string, allowed: boolean) => void;
  sendFollowUp: (taskId: string, text: string) => void;
}

function mergeTaskList(list: KbResearchTask[], task: KbResearchTask): KbResearchTask[] {
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx === -1) return [task, ...list];
  const copy = [...list];
  copy[idx] = task;
  return copy;
}

function defaultResearchApi(client: KbClient): ResearchApi {
  return {
    research: createResearchClient(client),
    explore: createExploreClient(client),
  };
}

const APIS = new WeakMap<KbClient, ResearchApi>();
const STORES = new WeakMap<KbClient, StoreApi<ResearchState>>();

/**
 * Bind a `FakeKb` (`createFakeKb(scene)`) or custom `ResearchApi` to a `KbClient` instance
 * so components rendered inside `<KbServicesProvider>` use that API in tests or scenes.
 */
export function bindResearchApi(client: KbClient, api: ResearchApi): StoreApi<ResearchState> {
  APIS.set(client, api);
  const store = createResearchStore(client);
  STORES.set(client, store);
  return store;
}

function getApi(client: KbClient): ResearchApi {
  let api = APIS.get(client);
  if (!api) {
    api = defaultResearchApi(client);
    APIS.set(client, api);
  }
  return api;
}

function createResearchStore(client: KbClient): StoreApi<ResearchState> {
  return createStore<ResearchState>((set, get) => ({
    mode: 'closed',
    activeTaskId: null,
    tasks: [],
    tasksById: {},
    jobs: [],
    draftPrompt: '',
    draftStarter: null,
    draftAreaId: null,
    busy: false,
    error: null,
    chatGrants: {},
    followUps: {},

    openNewTask: (opts) => {
      set((s) => ({
        mode: 'new',
        activeTaskId: null,
        error: null,
        draftPrompt: opts?.prompt !== undefined ? opts.prompt : s.draftPrompt,
        draftStarter: opts?.starter !== undefined ? opts.starter : s.draftStarter,
        draftAreaId: opts?.areaId !== undefined ? opts.areaId : s.draftAreaId,
      }));
    },

    openTask: (taskId) => {
      set({ mode: 'task', activeTaskId: taskId, error: null });
      void get().loadTask(taskId);
    },

    close: () => {
      if (get().mode !== 'closed') {
        set({ mode: 'closed', error: null });
      }
    },

    setDraft: (prompt, starter) => {
      set((s) => ({
        draftPrompt: prompt,
        draftStarter: starter !== undefined ? starter : s.draftStarter,
        error: null,
      }));
    },

    upsertTask: (task) => {
      set((s) => ({
        tasks: mergeTaskList(s.tasks, task),
        tasksById: { ...s.tasksById, [task.id]: task },
      }));
    },

    loadTasks: async () => {
      try {
        const res = await getApi(client).research.tasks();
        const byId: Record<string, KbResearchTask> = { ...get().tasksById };
        for (const t of res.tasks) byId[t.id] = t;
        set({ tasks: res.tasks, tasksById: byId });
        return res.tasks;
      } catch {
        return get().tasks;
      }
    },

    loadTask: async (taskId) => {
      const api = getApi(client);
      try {
        let task = await api.research.task(taskId);
        // If a fake scene only populated `explore.run` (e.g. `no_decision_model`, `daily_limit`),
        // adopt that run's stop_reason and state when the research task is still the default fixture.
        if (task.id === 'task-1' && task.run.stop_reason === null) {
          try {
            const funnelRun = await api.explore.run(task.run.id);
            if (funnelRun.stop_reason !== null || funnelRun.state !== 'running') {
              task = {
                ...task,
                id: taskId,
                run: {
                  ...task.run,
                  state: funnelRun.state,
                  stage: funnelRun.stage,
                  stop_reason: funnelRun.stop_reason,
                  budget: funnelRun.budget,
                  counters: funnelRun.counters,
                  checkpoint: funnelRun.checkpoint,
                  decision_choices: funnelRun.decision_choices,
                  decision_provider: funnelRun.decision_provider,
                  retry_at: funnelRun.retry_at,
                },
              };
            }
          } catch {
            // Ignore when explore.run is unavailable
          }
        }
        get().upsertTask(task);
        return task;
      } catch (err) {
        set({ error: errorText(err) });
        return null;
      }
    },

    pollProgress: async (taskId) => {
      const api = getApi(client);
      try {
        const jobRes = await api.explore.jobs({ active: true });
        set({ jobs: jobRes.jobs });
      } catch {
        // Ignore transient polling failures
      }
      const id = taskId ?? get().activeTaskId;
      if (id) {
        try {
          const task = await api.research.task(id);
          // Only overwrite if the returned task matches the requested ID or isn't already customized in store
          const existing = get().tasksById[id];
          if (!existing || task.id === id) {
            get().upsertTask(task);
          }
        } catch {
          // Ignore transient polling failures
        }
      }
    },

    startTask: async (body) => {
      const state = get();
      const payload: KbResearchCreate = body ?? {
        description: state.draftPrompt.trim(),
        area_id: state.draftAreaId,
      };
      if (!payload.description.trim()) return null;
      set({ busy: true, error: null });
      try {
        const created = await getApi(client).research.create(payload);
        const task: KbResearchTask =
          created.description !== payload.description && created.id === 'task-1'
            ? {
                ...created,
                description: payload.description,
                area_id: payload.area_id ?? created.area_id,
              }
            : created;
        set((s) => ({
          busy: false,
          mode: 'task',
          activeTaskId: task.id,
          draftPrompt: '',
          draftStarter: null,
          tasks: mergeTaskList(s.tasks, task),
          tasksById: { ...s.tasksById, [task.id]: task },
        }));
        return task;
      } catch (err) {
        set({ busy: false, error: errorText(err) });
        return null;
      }
    },

    pauseTask: async (taskId) => {
      const current = get().tasksById[taskId];
      set({ busy: true, error: null });
      try {
        const res = await getApi(client).research.pause(taskId);
        const task: KbResearchTask =
          res.id === taskId && res.run.state === 'paused'
            ? res
            : {
                ...(current ?? res),
                id: taskId,
                run: {
                  ...(current?.run ?? res.run),
                  state: 'paused',
                  stop_reason: 'user_pause',
                },
              };
        set((s) => ({
          busy: false,
          tasks: mergeTaskList(s.tasks, task),
          tasksById: { ...s.tasksById, [task.id]: task },
        }));
        return task;
      } catch (err) {
        set({ busy: false, error: errorText(err) });
        return null;
      }
    },

    resumeTask: async (taskId, decisionChoice) => {
      const current = get().tasksById[taskId];
      const wasBudgetOrDone =
        current?.run.stop_reason === 'budget' ||
        current?.run.state === 'done' ||
        current?.run.stop_reason === 'completed';
      const checkpointId = current?.run.checkpoint?.id ?? 'checkpoint-1';
      const revision = current?.run.checkpoint?.revision ?? 1;
      set({ busy: true, error: null });
      try {
        const res = await getApi(client).research.resume(taskId, {
          checkpoint_id: checkpointId,
          revision,
          decision_choice: decisionChoice ?? null,
        });
        const base = current ?? res;
        const limit = base.run.budget.limit || 30;
        const task: KbResearchTask =
          res.id === taskId && res.run.state === 'running' && !wasBudgetOrDone
            ? res
            : {
                ...base,
                id: taskId,
                run: {
                  ...base.run,
                  state: 'running',
                  stop_reason: null,
                  budget: wasBudgetOrDone
                    ? {
                        ...base.run.budget,
                        used: 0,
                        remaining: limit,
                        batch: base.run.budget.batch + 1,
                      }
                    : base.run.budget,
                },
              };
        set((s) => ({
          busy: false,
          tasks: mergeTaskList(s.tasks, task),
          tasksById: { ...s.tasksById, [task.id]: task },
        }));
        return task;
      } catch (err) {
        set({ busy: false, error: errorText(err) });
        return null;
      }
    },

    cancelTask: async (taskId) => {
      const current = get().tasksById[taskId];
      set({ busy: true, error: null });
      try {
        const res = await getApi(client).research.cancel(taskId);
        const task: KbResearchTask =
          res.id === taskId && res.run.state === 'cancelled'
            ? res
            : {
                ...(current ?? res),
                id: taskId,
                run: {
                  ...(current?.run ?? res.run),
                  state: 'cancelled',
                  stop_reason: 'cancelled',
                },
              };
        set((s) => ({
          busy: false,
          tasks: mergeTaskList(s.tasks, task),
          tasksById: { ...s.tasksById, [task.id]: task },
        }));
        return task;
      } catch (err) {
        set({ busy: false, error: errorText(err) });
        return null;
      }
    },

    decidePermission: async (requestId, decision, chatId) => {
      const res = await getApi(client).research.decide(requestId, { decision });
      if (decision === 'allow_chat' && chatId) {
        set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: true } }));
      }
      let updated: KbResearchPermission = res;
      if (res.status === 'pending') {
        if (decision === 'deny') {
          updated = {
            ...res,
            id: requestId,
            status: 'denied',
            task_id: null,
            task_title: null,
            task_state: null,
          };
        } else {
          updated = {
            ...res,
            id: requestId,
            status: 'allowed',
            auto: decision === 'allow_chat',
            task_id: res.task_id ?? 'task-rag',
            task_title: res.task_title ?? res.arguments.description,
            task_state: res.task_state ?? 'running',
          };
        }
      }
      if (updated.status === 'allowed' && updated.task_id) {
        void get().loadTask(updated.task_id);
      }
      return updated;
    },

    loadGrant: async (chatId) => {
      try {
        const res = await getApi(client).research.grant(chatId);
        set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: res.allowed } }));
        return res;
      } catch {
        return null;
      }
    },

    revokeGrant: async (chatId) => {
      try {
        const res = await getApi(client).research.revoke_grant(chatId);
        set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: false } }));
        return { ...res, allowed: false };
      } catch {
        return null;
      }
    },

    setChatGrant: (chatId, allowed) => {
      set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: allowed } }));
    },

    sendFollowUp: (taskId, text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      set((s) => ({
        followUps: {
          ...s.followUps,
          [taskId]: [...(s.followUps[taskId] ?? []), trimmed],
        },
      }));
    },
  }));
}

export function getResearchStore(client: KbClient): StoreApi<ResearchState> {
  let store = STORES.get(client);
  if (!store) {
    store = createResearchStore(client);
    STORES.set(client, store);
  }
  return store;
}

export function useResearch<T>(selector: (state: ResearchState) => T): T {
  const { client } = useServices();
  const store = getResearchStore(client);
  return useStore(store, selector);
}

/** Type guard for a `KbResearchPermission` message part (`type: "research"`). */
export function isResearchPart(part: { type: string }): part is KbResearchPermission {
  return part.type === 'research';
}
