import { create } from 'zustand';
import { ApiError } from '../api/client';
import type { BridgeApi } from '../api/bridge';
import type { Message, Note, NoteDetail } from '../api/types';
import {
  CodexClient,
  isActive,
  isSafeAuthUrl,
  type CodexChat,
  type CodexConnection,
  type CodexPreview,
  type CodexPurpose,
  type CodexScope,
  type CodexSettings,
  type CodexTask,
  type AgentView,
  type PurposeEngine,
} from '../api/codex';

// Renderer state for the Codex Assistant / Notes boundary. It holds only what
// the backend reports: chats, the app-wide task list, settings and connection.
// Nothing here starts a model turn, a login or a resume on its own — each of
// those is one explicit user action. Streaming is the backend's cumulative
// `task.answer`, read by polling while a task is active.

/**
 * Whether the boundary answered at all. `unavailable` means the backend does not
 * (yet) serve it, which leaves the existing assistant in place; it is never used
 * to hide a failure of a Codex path the user switched on.
 */
export type CodexAvailability = 'unknown' | 'available' | 'unavailable' | 'error';

/** The backend does not serve the boundary at all (missing route, blocked path, foreign body). */
const notServed = (err: unknown): boolean => err instanceof ApiError && (
  err.status === 404 || err.status === 405
  || (err.status === 0 && /^(method\/path not allowed|Unexpected state response)/.test(err.message)));

export interface ChatView {
  chat: CodexChat;
  messages: Message[];
  tasks: CodexTask[];
}

/**
 * The browser login as the renderer follows it: `waiting` while the backend
 * reports the page open, `failed` once it ended without an account (the
 * message says how). Success simply shows as a connected account.
 */
export interface LoginWatch {
  phase: 'idle' | 'waiting' | 'failed';
  message: string | null;
}

const LOGIN_IDLE: LoginWatch = { phase: 'idle', message: null };

export interface CodexStoreState {
  availability: CodexAvailability;
  unavailableReason: string | null;
  settings: CodexSettings | null;
  connection: CodexConnection | null;
  /** Per purpose: which engine answers, and whether API agent mode can run (null: not served). */
  agent: AgentView | null;
  /** The session whose chat list is loaded. */
  sessionId: string | null;
  chats: CodexChat[];
  selectedChatId: string | null;
  /** App-wide: every session's tasks, the single visible queue. */
  tasks: CodexTask[];
  views: Record<string, ChatView>;
  previews: Record<string, CodexPreview[]>;
  /** Last failed user action, shown where the action was taken. */
  error: string | null;
  connecting: boolean;
  loginWatch: LoginWatch;

  load:(sessionId: string | null) => Promise<void>;
  poll: () => Promise<void>;
  openChat: (chatId: string) => Promise<void>;
  newChat: (scope: CodexScope) => Promise<CodexChat | null>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<boolean>;
  send: (chatId: string, question: string, confirmedLarge?: boolean) => Promise<SendOutcome>;
  stop: (taskId: string) => Promise<void>;
  resume: (taskId: string) => Promise<void>;
  generateNotes: (sessionId: string, language: string, detail: NoteDetail) => Promise<CodexTask>;
  saveSettings: (settings: CodexSettings) => Promise<CodexSettings>;
  /** Re-read which engine each purpose uses, e.g. after its API profile was saved. */
  refreshAgent: () => Promise<void>;
  checkConnection: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  loadPreviews: (chatId: string) => Promise<void>;
  applyPreview: (preview: CodexPreview) => Promise<Note>;
  discardPreview: (preview: CodexPreview) => Promise<void>;
  clearError: () => void;
}

/**
 * The outcome of a send. `confirm` means the backend asked for explicit
 * approval of a large job (HTTP 428, its detail describes the scope); the UI
 * shows that description and resends only on the user's approval.
 */
export type SendOutcome =
  | { kind: 'sent'; task: CodexTask }
  | { kind: 'confirm'; detail: string }
  | { kind: 'error'; detail: string };

const POLL_MS = 750;
/** How often the open browser login is re-read. */
const LOGIN_POLL_MS = 1500;
/** Just past the backend's own 300 s login limit, so its verdict normally arrives first. */
const LOGIN_WATCH_MS = 310_000;
/** Consecutive unreadable results before the watch gives up. */
const LOGIN_READ_FAILURES = 3;

const LOGIN_ENDED: Record<string, string> = {
  failed: 'Sign-in did not finish. Try again.',
  cancelled: 'Sign-in cancelled.',
  timed_out: 'Sign-in timed out. Try again.',
};

/**
 * What a connection read says about an open login: `null` while it is still
 * open, `connected` on success, otherwise the message to show.
 */
function loginVerdict(connection: CodexConnection): 'connected' | string | null {
  if (connection.status === 'connected') return 'connected';
  const ended = connection.login ? LOGIN_ENDED[connection.login] : undefined;
  if (ended) return ended;
  if (connection.status === 'error') return `Could not verify the account after sign-in: ${connection.error ?? 'no details'}`;
  if (connection.status === 'missing' || connection.status === 'incompatible') return 'Codex is unavailable — sign-in did not finish.';
  return null;
}

// Each login starts a new watch; a newer login, logout or stopLoginWatch()
// retires the previous one.
let loginRun = 0;

/** Stop following the browser login (tests; also replaced by a newer attempt). */
export function stopLoginWatch(): void {
  loginRun += 1;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Connection states that the backend is still resolving on its own. */
const PENDING_CONNECTION = new Set(['unchecked', 'checking']);
const CONNECTION_POLL_MS = 1000;
/** A launch check reads a version and the account: well under this. */
const CONNECTION_WATCH_MS = 30_000;
let connectionWatch = false;

let codexClient: CodexClient | null = null;
let codexBridge: BridgeApi | null = null;
const client = (): CodexClient => {
  if (!codexClient || codexBridge !== window.skaz) {
    codexClient = new CodexClient(window.skaz);
    codexBridge = window.skaz;
  }
  return codexClient;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type SettledListener = (task: CodexTask) => void;
const settledListeners = new Set<SettledListener>();

/** Called once when a task leaves the active states (completed, failed, paused, cancelled). */
export function onTaskSettled(listener: SettledListener): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

export function stopCodexPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

const mergeTask = (tasks: CodexTask[], task: CodexTask): CodexTask[] => {
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index < 0) return [...tasks, task];
  const next = tasks.slice();
  next[index] = task;
  return next;
};

/** Sorted by last activity, most recent first — the order of the chat picker. */
export const byActivity = (chats: CodexChat[]): CodexChat[] =>
  [...chats].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

export const useCodex = create<CodexStoreState>((set, get) => {
  /** Report tasks that just left the active states, exactly once each. */
  const settle = (before: CodexTask[], after: CodexTask[]) => {
    const wasActive = new Set(before.filter(isActive).map((t) => t.id));
    for (const task of after) {
      if (wasActive.has(task.id) && !isActive(task)) {
        for (const listener of settledListeners) listener(task);
      }
    }
  };

  const applyTasks = (incoming: CodexTask[]) => {
    const before = get().tasks;
    set({ tasks: incoming });
    settle(before, incoming);
  };

  const refreshView = async (chatId: string) => {
    const detail = await client().chat(chatId);
    set((s) => ({
      views: { ...s.views, [chatId]: { chat: detail.chat, messages: detail.messages, tasks: detail.tasks } },
      chats: s.chats.map((c) => (c.id === chatId ? detail.chat : c)),
    }));
  };

  /**
   * Follow the browser login until the backend reports its end, so the account
   * and model catalog appear without a manual check. Bounded by time and by
   * consecutive read failures; never retries the login itself.
   */
  const watchLogin = async (run: number) => {
    const deadline = Date.now() + LOGIN_WATCH_MS;
    let failures = 0;
    const end = (watch: LoginWatch) => { if (run === loginRun) set({ loginWatch: watch }); };
    while (run === loginRun) {
      await wait(LOGIN_POLL_MS);
      if (run !== loginRun) return;
      let connection: CodexConnection;
      try {
        // The side-effect-free state read: no check, login or model call.
        connection = (await client().state(null)).connection;
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= LOGIN_READ_FAILURES) {
          end({ phase: 'failed', message: `Could not get the sign-in result: ${message(err)}` });
          return;
        }
        continue;
      }
      if (run !== loginRun) return;
      set({ connection });
      const verdict = loginVerdict(connection);
      if (verdict === 'connected') { end(LOGIN_IDLE); return; }
      if (verdict) { end({ phase: 'failed', message: verdict }); return; }
      if (Date.now() >= deadline) {
        end({ phase: 'failed', message: LOGIN_ENDED.timed_out! });
        return;
      }
    }
  };

  /**
   * Follow the launch/background connection check until it settles, so the
   * banner turns into a connected composer without a manual check. Bounded.
   */
  const watchConnection = async () => {
    if (connectionWatch) return;
    connectionWatch = true;
    try {
      const deadline = Date.now() + CONNECTION_WATCH_MS;
      // Always re-read at least once: a just-paused task may start the check
      // a moment after the read that reported the pause.
      while (Date.now() < deadline) {
        await wait(CONNECTION_POLL_MS);
        try {
          set({ connection: (await client().state(null)).connection });
        } catch {
          return;
        }
        const status = get().connection?.status;
        if (status && !PENDING_CONNECTION.has(status)) return;
      }
    } finally {
      connectionWatch = false;
    }
  };

  const schedule = () => {
    if (pollTimer) return;
    const anyActive = get().tasks.some(isActive)
      || Object.values(get().views).some((v) => v.tasks.some(isActive));
    if (!anyActive) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void get().poll();
    }, POLL_MS);
  };

  return {
    availability: 'unknown',
    unavailableReason: null,
    settings: null,
    connection: null,
    agent: null,
    sessionId: null,
    chats: [],
    selectedChatId: null,
    tasks: [],
    views: {},
    previews: {},
    error: null,
    connecting: false,
    loginWatch: LOGIN_IDLE,

    load: async (sessionId) => {
      set({ sessionId, error: null, ...(sessionId !== get().sessionId ? { chats: [], selectedChatId: null } : {}) });
      try {
        const state = await client().state(sessionId);
        if (get().sessionId !== sessionId) return;
        set({
          availability: 'available',
          unavailableReason: null,
          settings: state.settings,
          connection: state.connection,
          agent: state.agent ?? null,
          chats: state.chats,
          selectedChatId: state.selected_chat_id,
        });
        applyTasks(state.tasks);
        // The backend checks a saved sign-in at launch; follow it to its verdict.
        if (PENDING_CONNECTION.has(state.connection.status)) void watchConnection();
        // Returning to a session reopens the chat last chosen in it.
        if (state.selected_chat_id) await get().openChat(state.selected_chat_id);
        schedule();
      } catch (err) {
        if (get().sessionId !== sessionId) return;
        // Only a missing route or a non-contract body means "not served". Any
        // other failure is reported as such: which engine the user chose is
        // then unknown, so the old assistant must not quietly take over.
        if (get().availability !== 'available' && notServed(err)) {
          set({ availability: 'unavailable', unavailableReason: message(err) });
        } else if (get().availability === 'available') {
          set({ error: message(err) });
        } else {
          set({ availability: 'error', unavailableReason: message(err) });
        }
      }
    },

    poll: async () => {
      if (polling) return;
      polling = true;
      try {
        const { sessionId, selectedChatId } = get();
        const state = await client().state(sessionId);
        if (get().sessionId === sessionId) {
          set({ chats: state.chats, connection: state.connection, agent: state.agent ?? null });
        }
        const before = get().tasks;
        applyTasks(state.tasks);
        // An interrupted task makes the backend re-read the account.
        if (PENDING_CONNECTION.has(state.connection.status)
          || before.some((t) => isActive(t) && state.tasks.some((n) => n.id === t.id && n.status === 'paused'))) {
          void watchConnection();
        }
        // The open chat and any chat whose task just ended are re-read so the
        // final answer lands as a stored message rather than a stale stream.
        const touched = new Set<string>();
        if (selectedChatId) {
          const view = get().views[selectedChatId];
          if (view?.tasks.some(isActive) || state.tasks.some((t) => t.chat_id === selectedChatId && isActive(t))) {
            touched.add(selectedChatId);
          }
        }
        for (const task of before) {
          const now = state.tasks.find((t) => t.id === task.id);
          if (isActive(task) && (!now || !isActive(now)) && get().views[task.chat_id]) touched.add(task.chat_id);
        }
        await Promise.all([...touched].map(async (chatId) => {
          await refreshView(chatId);
          if (!get().views[chatId]?.tasks.some(isActive)) await get().loadPreviews(chatId);
        }));
      } catch (err) {
        set({ error: message(err) });
      } finally {
        polling = false;
        schedule();
      }
    },

    openChat: async (chatId) => {
      set({ selectedChatId: chatId, error: null });
      try {
        await refreshView(chatId);
        // Selecting also records it as this session's last chat (and read).
        const chat = await client().selectChat(chatId);
        set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...chat, unread: false } : c)) }));
        await get().loadPreviews(chatId);
        schedule();
      } catch (err) {
        set({ error: message(err) });
      }
    },

    newChat: async (scope) => {
      const sessionId = get().sessionId;
      if (!sessionId) return null;
      try {
        const chat = await client().createChat(sessionId, scope);
        set((s) => ({ chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)], error: null }));
        await get().openChat(chat.id);
        return chat;
      } catch (err) {
        set({ error: message(err) });
        return null;
      }
    },

    renameChat: async (chatId, title) => {
      try {
        const chat = await client().renameChat(chatId, title);
        set((s) => ({
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...chat } : c)),
          views: s.views[chatId] ? { ...s.views, [chatId]: { ...s.views[chatId]!, chat: { ...s.views[chatId]!.chat, ...chat } } } : s.views,
        }));
      } catch (err) {
        set({ error: message(err) });
      }
    },

    deleteChat: async (chatId) => {
      try {
        await client().deleteChat(chatId);
        set((s) => {
          const { [chatId]: _view, ...views } = s.views;
          const { [chatId]: _previews, ...previews } = s.previews;
          return {
            chats: s.chats.filter((c) => c.id !== chatId),
            selectedChatId: s.selectedChatId === chatId ? null : s.selectedChatId,
            views,
            previews,
            error: null,
          };
        });
        // The backend stops the chat's own task first; read the queue it left.
        await get().poll();
        return true;
      } catch (err) {
        set({ error: message(err) });
        return false;
      }
    },

    send: async (chatId, question, confirmedLarge = false) => {
      try {
        const task = await client().send(chatId, question, confirmedLarge);
        set((s) => ({
          tasks: mergeTask(s.tasks, task),
          views: s.views[chatId]
            ? { ...s.views, [chatId]: { ...s.views[chatId]!, tasks: mergeTask(s.views[chatId]!.tasks, task) } }
            : s.views,
          error: null,
        }));
        await refreshView(chatId).catch(() => undefined);
        schedule();
        return { kind: 'sent', task };
      } catch (err) {
        if (err instanceof ApiError && err.status === 428) return { kind: 'confirm', detail: err.message };
        return { kind: 'error', detail: message(err) };
      }
    },

    stop: async (taskId) => {
      try {
        const task = await client().stop(taskId);
        set((s) => ({ tasks: mergeTask(s.tasks, task), error: null }));
        await get().poll();
      } catch (err) {
        set({ error: message(err) });
      }
    },

    resume: async (taskId) => {
      try {
        const task = await client().resume(taskId);
        set((s) => ({ tasks: mergeTask(s.tasks, task), error: null }));
        if (get().views[task.chat_id]) await refreshView(task.chat_id).catch(() => undefined);
        schedule();
      } catch (err) {
        set({ error: message(err) });
      }
    },

    generateNotes: async (sessionId, language, detail) => {
      const task = await client().generateNotes(sessionId, language, detail);
      set((s) => ({ tasks: mergeTask(s.tasks, task) }));
      schedule();
      return task;
    },

    saveSettings: async (settings) => {
      const saved = await client().saveSettings(settings);
      set({ settings: saved });
      await get().refreshAgent();
      return saved;
    },

    refreshAgent: async () => {
      try {
        const state = await client().state(null);
        set({ agent: state.agent ?? null, settings: state.settings });
      } catch {
        // The next load or poll reads it again; the saved settings are already applied.
      }
    },

    checkConnection: async () => {
      // A fresh explicit check supersedes how an earlier login attempt ended.
      set({ connecting: true, error: null, loginWatch: LOGIN_IDLE });
      try {
        set({ connection: await client().checkConnection() });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ connecting: false });
      }
    },

    login: async () => {
      stopLoginWatch();
      set({ connecting: true, error: null, loginWatch: LOGIN_IDLE });
      try {
        const { auth_url: url } = await client().login();
        if (!isSafeAuthUrl(url)) throw new Error('Codex returned an unsafe sign-in address; it was not opened.');
        // Main hands https links to the OS browser and denies the new window.
        window.open(url, '_blank', 'noopener');
        set({ loginWatch: { phase: 'waiting', message: null } });
        void watchLogin(loginRun);
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ connecting: false });
      }
    },

    logout: async () => {
      stopLoginWatch();
      set({ connecting: true, error: null, loginWatch: LOGIN_IDLE });
      try {
        set({ connection: await client().logout() });
      } catch (err) {
        set({ error: message(err) });
      } finally {
        set({ connecting: false });
      }
    },

    loadPreviews: async (chatId) => {
      try {
        const previews = await client().previews(chatId);
        set((s) => ({ previews: { ...s.previews, [chatId]: previews } }));
      } catch (err) {
        set({ error: message(err) });
      }
    },

    applyPreview: async (preview) => {
      const note = await client().applyPreview(preview.id);
      set((s) => ({
        previews: { ...s.previews, [preview.chat_id]: (s.previews[preview.chat_id] ?? [])
          .map((p) => (p.id === preview.id ? { ...p, status: 'applied' as const } : p)) },
      }));
      return note;
    },

    discardPreview: async (preview) => {
      await client().discardPreview(preview.id);
      set((s) => ({
        previews: { ...s.previews, [preview.chat_id]: (s.previews[preview.chat_id] ?? [])
          .filter((p) => p.id !== preview.id) },
      }));
    },

    clearError: () => set({ error: null }),
  };
});

/**
 * Codex drives one purpose only once the boundary answers and the user chose
 * Codex for that purpose; the other purpose keeps its own choice.
 */
const selectCodexFor = (purpose: CodexPurpose) => (s: CodexStoreState): boolean =>
  s.availability === 'available'
  && (purpose === 'assistant' ? s.settings?.assistant_enabled : s.settings?.notes_enabled) === true;

export const selectCodexAssistant = selectCodexFor('assistant');
export const selectCodexNotes = selectCodexFor('notes');

/** The engine the settings choose for a purpose, as far as the renderer knows. */
export const engineOf = (s: CodexStoreState, purpose: CodexPurpose): PurposeEngine => {
  if (s.availability !== 'available' || !s.settings) return 'api';
  const keys = purpose === 'assistant'
    ? { codex: s.settings.assistant_enabled, agent: s.settings.assistant_api_agent }
    : { codex: s.settings.notes_enabled, agent: s.settings.notes_api_agent };
  return keys.codex ? 'codex' : keys.agent === true ? 'api_agent' : 'api';
};

/**
 * The purpose runs as a tool-driven agent — on Codex or on its API profile —
 * and therefore through the chats, the queue and the task cards.
 */
const selectAgentFor = (purpose: CodexPurpose) => (s: CodexStoreState): boolean => engineOf(s, purpose) !== 'api';

export const selectAgentAssistant = selectAgentFor('assistant');
export const selectAgentNotes = selectAgentFor('notes');

/**
 * Why API agent mode cannot run for a purpose, or null when it can (or is not chosen).
 * Nothing is sent while this has a value: no fallback to the one-pass path.
 */
export const apiAgentBlock = (s: CodexStoreState, purpose: CodexPurpose): string | null => {
  if (engineOf(s, purpose) !== 'api_agent') return null;
  const status = s.agent?.[purpose]?.api_agent;
  if (!status) return 'Agent mode status is not available yet.';
  return status.available ? null : (status.reason ?? 'Agent mode cannot run with this model.');
};

// Main guards quit while a task is still active. One-way and optional, so the
// test bridge stub is a no-op.
let lastActiveCount = -1;
useCodex.subscribe((state) => {
  const count = state.tasks.filter(isActive).length;
  if (count === lastActiveCount) return;
  lastActiveCount = count;
  window.skaz.reportCodexActivity?.(count);
});
