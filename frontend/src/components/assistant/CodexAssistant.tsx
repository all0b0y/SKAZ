import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { apiAgentBlock, engineOf, useCodex } from '../../state/codex';
import { isActive, type CodexScope, type CodexTask } from '../../api/codex';
import type { Citation, Note } from '../../api/types';
import { SessionDialog } from '../sessions/SessionOverlays';
import {
  AssistantComposer, AssistantError, AssistantNotice, AssistantShell, ConversationThread, EMPTY_HINT, MessageItem,
  QuoteChip, withQuote,
} from './AssistantShell';
import { CodexChatPicker } from './CodexChatPicker';
import { CodexPreviewCard } from './CodexPreviewCard';
import { CodexQueue } from './CodexQueue';
import { CodexTaskCard } from './CodexTaskCard';
import { CodexConnectionNotice } from './CodexConnectionNotice';
import { SCOPE_HINT, SCOPE_LABEL, connectionBlockOf } from './codexLabels';

interface Props {
  onCite: (citation: Citation) => void;
  onOpenSettings?: () => void;
}

const EMPTY: never[] = [];

/** The newest task of a chat, if it has not completed: the one the thread shows live. */
function openTask(tasks: CodexTask[]): CodexTask | null {
  const last = tasks.at(-1);
  return last && last.status !== 'completed' ? last : null;
}

/**
 * The agent Assistant (CODEX-ASSISTANT-SPEC §5, §7) on Codex or on the API
 * profile in agent mode: independent chats per session with a fixed,
 * always-visible scope; one app-wide queue; live answer, stop, manual resume,
 * confirmable note edits. Both engines read the library through the same tools.
 */
export function CodexAssistant({ onCite, onOpenSettings }: Props) {
  const activeId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const knownNotes = useStore((s) => s.detail?.notes_list) ?? EMPTY;
  const askContext = useStore((s) => s.askContext);
  const setAskContext = useStore((s) => s.setAskContext);

  const chats = useCodex((s) => s.chats);
  const selectedChatId = useCodex((s) => s.selectedChatId);
  const views = useCodex((s) => s.views);
  const tasks = useCodex((s) => s.tasks);
  const previews = useCodex((s) => (s.selectedChatId ? s.previews[s.selectedChatId] : undefined)) ?? EMPTY;
  const settings = useCodex((s) => s.settings);
  const connection = useCodex((s) => s.connection);
  const error = useCodex((s) => s.error);
  const engine = useCodex((s) => engineOf(s, 'assistant'));
  const apiBlock = useCodex((s) => apiAgentBlock(s, 'assistant'));
  const codex = useCodex.getState;

  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ chatId: string; text: string; detail: string } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);

  const selected = chats.find((c) => c.id === selectedChatId) ?? views[selectedChatId ?? '']?.chat ?? null;
  const view = selectedChatId ? views[selectedChatId] : undefined;
  const messages = view?.messages ?? EMPTY;
  // The app-wide list is fresher than the chat read while a task streams.
  const current = useMemo(() => {
    const own = openTask(view?.tasks ?? []);
    if (!own) return tasks.filter((t) => t.chat_id === selectedChatId && isActive(t)).at(-1) ?? null;
    return tasks.find((t) => t.id === own.id) ?? own;
  }, [view, tasks, selectedChatId]);

  // No model is ever substituted: without the user's choice nothing is sent.
  const onCodex = engine === 'codex';
  const block = onCodex ? connectionBlockOf(connection) : null;
  const blocked = !onCodex ? apiBlock : block?.text
    ?? (settings && (!settings.assistant_model || !settings.assistant_effort)
      ? 'Choose a Codex model and reasoning effort for Assistant.' : null);
  const revoked = selected?.revoked === true;
  const running = current?.status === 'running';
  const waiting = current && current.status !== 'running'
    && ['preparing', 'queued', 'stopping', 'paused'].includes(current.status);

  useEffect(() => { setSendError(null); }, [selectedChatId, activeId]);

  const placeholder = !activeId ? 'Start a session to ask questions'
    : waiting ? (current!.status === 'paused'
      ? 'The task was interrupted — resume it or start a new chat'
      : 'This chat has a running task — wait for it or cancel it')
    : running ? 'Refine the current task…'
    : 'Ask about your recordings…';
  const canType = !!activeId && !blocked && !revoked && !waiting && !sending;

  const deliver = async (chatId: string, text: string, confirmedLarge: boolean) => {
    setSending(true);
    setSendError(null);
    const outcome = await codex().send(chatId, text, confirmedLarge);
    setSending(false);
    if (outcome.kind === 'confirm') {
      setDontAsk(false);
      setConfirm({ chatId, text, detail: outcome.detail });
      return;
    }
    if (outcome.kind === 'error') { setSendError(outcome.detail); return; }
    setQuestion('');
    setAskContext(null);
  };

  const submit = async () => {
    const trimmed = question.trim();
    if (!trimmed || !canType) return;
    const text = withQuote(trimmed, askContext);
    let chatId = selected?.id ?? null;
    if (!chatId) {
      // The first question of a session opens a chat with the default scope.
      const chat = await codex().newChat('session');
      if (!chat) return;
      chatId = chat.id;
    }
    await deliver(chatId, text, false);
  };

  const proceedLarge = async () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    if (dontAsk && settings) {
      try {
        await codex().saveSettings({ ...settings, ask_before_large: false });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
    }
    await deliver(pending.chatId, pending.text, true);
  };

  const newChat = (scope: CodexScope) => { void codex().newChat(scope); };
  const onApplied = (_preview: unknown, saved: Note) => {
    useStore.setState((state) => (!state.detail || !(state.detail.notes_list ?? []).some((n) => n.id === saved.id) ? {} : {
      detail: { ...state.detail, notes: state.detail.notes?.id === saved.id ? saved : state.detail.notes,
        notes_list: (state.detail.notes_list ?? []).map((n) => (n.id === saved.id ? saved : n)) },
    }));
  };
  const isEmpty = messages.length === 0 && !current && !previews.some((p) => p.status === 'pending');

  return (
    <AssistantShell engine={onCodex ? 'codex' : 'api_agent'} head={(
      <>
        <CodexChatPicker
          chats={chats}
          selected={selected}
          tasks={tasks}
          disabled={!activeId}
          onSelect={(id) => void codex().openChat(id)}
          onCreate={newChat}
          onRename={(id, title) => void codex().renameChat(id, title)}
          onDelete={(id) => codex().deleteChat(id)}
        />
        <span className="codex-head__scope" title={SCOPE_HINT[selected?.scope ?? 'session']}
          aria-label={`Chat scope: ${SCOPE_LABEL[selected?.scope ?? 'session']}`}>
          {SCOPE_LABEL[selected?.scope ?? 'session']}
        </span>
        <CodexQueue tasks={tasks} sessions={sessions}
          onStop={(id) => void codex().stop(id)} onResume={(id) => void codex().resume(id)} />
      </>
    )}>
      <ConversationThread messages={messages} activeSessionId={activeId} onCite={onCite} empty={isEmpty}
        hint={askContext ? null : selected ? EMPTY_HINT : 'A new chat uses the Session scope. Group and All are in the chat list.'}
        scrollKey={`${selectedChatId}:${messages.length}:${current?.status}:${current?.answer.length}`}>
        {current && current.kind === 'chat'
          && !messages.some((m) => m.role === 'user' && m.content === current.question) && (
          <MessageItem role="user" content={current.question} activeSessionId={activeId} onCite={onCite} />
        )}
        {current && (
          <CodexTaskCard task={current} activeSessionId={activeId} readOnly={revoked} onCite={onCite}
            onStop={(id) => void codex().stop(id)} onResume={(id) => void codex().resume(id)}
            onOpenSettings={onOpenSettings} />
        )}
        {previews.map((preview) => (
          <CodexPreviewCard key={preview.id} preview={preview} sessions={sessions} knownNotes={knownNotes}
            readOnly={revoked}
            onApply={(p) => codex().applyPreview(p)} onDiscard={(p) => codex().discardPreview(p)}
            onApplied={onApplied} />
        ))}
      </ConversationThread>

      {(sendError || error) && <AssistantError>{sendError ?? error}</AssistantError>}

      {revoked && selected && (
        <AssistantNotice role="status"
          text="This chat’s sources changed and access was revoked. The history is read-only."
          action={{ label: `New chat · ${SCOPE_LABEL[selected.scope]}`, onClick: () => newChat(selected.scope) }} />
      )}
      {!revoked && blocked && (
        <CodexConnectionNotice block={block} text={blocked} onOpenSettings={onOpenSettings}
          settingsLabel={onCodex ? 'Open Codex settings' : 'Open Assistant settings'} />
      )}

      {askContext && <QuoteChip quote={askContext} onClear={() => setAskContext(null)} />}

      <AssistantComposer value={question} onChange={setQuestion} onSubmit={() => void submit()}
        placeholder={placeholder} label={running ? 'Refinement for the current task' : 'Question'}
        sendLabel={running ? 'Refine task' : 'Send question'} disabled={!canType} focusOn={askContext} />

      {confirm && (
        <SessionDialog title="Large task" onClose={() => setConfirm(null)}>
          <p>{confirm.detail}</p>
          <label className="consent">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            <span>Don’t ask again (you can turn it back on in Settings → Assistant)</span>
          </label>
          <div className="session-dialog__actions">
            <button className="btn btn--quiet" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn--primary" onClick={() => void proceedLarge()}>Run</button>
          </div>
        </SessionDialog>
      )}
    </AssistantShell>
  );
}
