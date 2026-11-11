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
  revokeGrant: (chatId: string) => Promise<KbResearchGrant>;
  setChatGrant: (chatId: string, allowed: boolean) => void;
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
  return createStore<ResearchState>((set, get) => {
  const generations = new Map<string, number>();
  const reads = new Map<string, number>();
  const actions = new Set<string>();
  let listRead = 0;
  const generation = (id: string) => generations.get(id) ?? 0;
  const invalidate = (id: string) => generations.set(id, generation(id) + 1);
  const isOlder = (task: KbResearchTask, current?: KbResearchTask) => current !== undefined
    && Date.parse(task.run.updated_at) < Date.parse(current.run.updated_at);
  // Pause / Continue / Cancel: the server's answer is the new state, nothing is guessed locally.
  const runTaskAction = async (
    taskId: string,
    call: (api: ResearchApi) => Promise<KbResearchTask>,
  ): Promise<KbResearchTask | null> => {
    if (actions.has(taskId)) return null;
    actions.add(taskId);
    invalidate(taskId);
    let failed = false;
    set({ busy: true, error: null });
    try {
      const task = await call(getApi(client));
      invalidate(taskId);
      get().upsertTask(task);
      return task;
    } catch (err) {
      failed = true;
      invalidate(taskId);
      set({ error: errorText(err) });
      return null;
    } finally {
      actions.delete(taskId);
      set({ busy: actions.size > 0 });
      if (failed) void get().loadTask(taskId);
    }
  };
  return {
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
      if (isOlder(task, get().tasksById[task.id])) return;
      set((s) => ({
        tasks: mergeTaskList(s.tasks, task),
        tasksById: { ...s.tasksById, [task.id]: task },
      }));
    },

    loadTasks: async () => {
      const request = ++listRead;
      const versions = new Map(generations);
      try {
        let res = await getApi(client).research.tasks();
        const tasks = [...res.tasks];
        const seen = new Set<string>();
        while (res.next_cursor) {
          const cursor = res.next_cursor;
          if (seen.has(cursor)) throw new Error('Couldn’t load the remaining tasks. Try again.');
          seen.add(cursor);
          res = await getApi(client).research.tasks({ cursor });
          tasks.push(...res.tasks);
        }
        if (request !== listRead) return get().tasks;
        const byId = { ...get().tasksById };
        for (const task of tasks) {
          if (!actions.has(task.id) && (versions.get(task.id) ?? 0) === generation(task.id) && !isOlder(task, byId[task.id])) byId[task.id] = task;
        }
        const ids = [...new Set(tasks.map((task) => task.id))];
        const listed = ids.flatMap((id) => byId[id] ? [byId[id]!] : []);
        const extras = get().tasks.filter((task) => !ids.includes(task.id));
        set({ tasks: [...extras, ...listed], tasksById: byId });
        return get().tasks;
      } catch (err) {
        if (request === listRead) set({ error: errorText(err) });
        return get().tasks;
      }
    },

    loadTask: async (taskId) => {
      const version = generation(taskId);
      const request = (reads.get(taskId) ?? 0) + 1;
      reads.set(taskId, request);
      try {
        const task = await getApi(client).research.task(taskId);
        if (version !== generation(taskId) || request !== reads.get(taskId) || actions.has(taskId)) {
          return get().tasksById[taskId] ?? null;
        }
        get().upsertTask(task);
        return get().tasksById[taskId] ?? null;
      } catch (err) {
        if (version === generation(taskId) && request === reads.get(taskId) && !actions.has(taskId)) set({ error: errorText(err) });
        return null;
      }
    },

    // GET /kb/explore/jobs ~1/s while a task is on screen (CONTRACT "Live state"). The job list is
    // cheap; the task itself is read again only when its job changed or left the active list.
    pollProgress: async (taskId) => {
      const api = getApi(client);
      const id = taskId ?? get().activeTaskId;
      try {
        const jobRes = await api.explore.jobs({ active: true });
        set({ jobs: jobRes.jobs });
        const known = id ? get().tasksById[id] : undefined;
        if (id && known) {
          const job = jobRes.jobs.find((j) => j.id === known.run.id);
          const unchanged = job !== undefined && job.updated_at === known.run.updated_at && job.state === known.run.state;
          if (!unchanged) await get().loadTask(id);
        }
      } catch {
        // A missed tick is not an error; the next one tries again.
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
        const task = await getApi(client).research.create(payload);
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

    pauseTask: async (taskId) => runTaskAction(taskId, (api) => api.research.pause(taskId)),

    cancelTask: async (taskId) => runTaskAction(taskId, (api) => api.research.cancel(taskId)),

    resumeTask: async (taskId, decisionChoice) => {
      const checkpoint = get().tasksById[taskId]?.run.checkpoint;
      if (!checkpoint) {
        set({ error: 'There is no saved point to continue from yet. Try again in a moment.' });
        return null;
      }
      return runTaskAction(taskId, (api) =>
        api.research.resume(taskId, {
          checkpoint_id: checkpoint.id,
          revision: checkpoint.revision,
          decision_choice: decisionChoice ?? null,
        }),
      );
    },

    decidePermission: async (requestId, decision, chatId) => {
      const updated = await getApi(client).research.decide(requestId, { decision });
      if (decision === 'allow_chat' && chatId && updated.status === 'allowed') {
        set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: true } }));
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
      // Errors reach the caller (the chip shows them); the grant is gone only if the server says so.
      const res = await getApi(client).research.revoke_grant(chatId);
      set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: res.allowed } }));
      return res;
    },

    setChatGrant: (chatId, allowed) => {
      set((s) => ({ chatGrants: { ...s.chatGrants, [chatId]: allowed } }));
    },

  };
  });
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
