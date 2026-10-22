import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { KbMessage } from '../../api/kb/types.gen';
import { Banner, Button, Spinner } from '../ui';
import { Composer } from '../composer/Composer';
import { useAgents, useChats, useServices } from '../state/context';
import { agentOf } from '../state/agents';
import { AgentFix } from './AgentFix';
import { useOpenDocument } from '../state/document';
import { ChatMenu, RenameForm } from './ChatMenu';
import { AssistantMessage, SystemMessage, UserMessage } from './Message';
import { useQuestionActions } from './useQuestionActions';
import { partsOf } from '../api/permissions';
import { WebSearchChip } from './webSearch';
import { DiagramFixProvider, type DiagramFix } from '../ui/markdown/Diagram';
import { diagramFixRequest, fixLanguage } from './diagramFix';
import { savedText } from './saved';
import type { KbChat } from '../../api/kb/types.gen';
import { isAnswering, type ChatsData, type ChatsStore } from '../state/chats';
import { DitherStage } from '../fx/dither/DitherStage';
import { ChatBackdrop } from '../fx/backdrop/ChatBackdrop';

/** What waits for the user in this chat, for the message field's hint (P4, Q-A2): nothing blocks typing. */
function waitingHint(chat: KbChat | null): string | null {
  const parts = chat?.messages.flatMap((m) => partsOf(m)) ?? [];
  if (parts.some((p) => p.type === 'question' && p.status === 'pending')) return 'Pick an option above, or just type…';
  if (parts.some((p) => (p.type === 'permission' || p.type === 'web_search') && p.status === 'pending')) return 'You can keep typing — the request waits';
  return null;
}

function useNotice(): [string | null, (text: string | null, ms?: number) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [notice, (text: string | null, ms = 5000) => {
    setNotice(text);
    window.clearTimeout(timer.current);
    if (text !== null) timer.current = window.setTimeout(() => setNotice(null), ms);
  }];
}

/** The burn-out of the empty view when the first message goes (FX-EFFECTS-SPEC Batch A §6). */
export const LEAVE_MS = 700;
/** Reduced motion: a plain fade, no longer than this. */
export const LEAVE_REDUCED_MS = 200;

/** The empty view on screen: '' = the new, not yet created chat; an id = an open chat with no messages; null = none. */
function emptyViewOf(s: ChatsData): string | null {
  if (!s.currentId) return '';
  const chat = s.chats[s.currentId]?.chat;
  return chat && chat.messages.length === 0 ? s.currentId : null;
}

interface LeaveState {
  /** The chat whose empty view is burning out, for LEAVE_MS. */
  leaving: string | null;
  /** The chat the first message created from the new-chat view: its plate keeps the new-chat copy. */
  bornHere: string | null;
}

/**
 * Watches the chats store change by change (not render by render, which may skip the in-between
 * states) for the moment the empty view gets its first message. Opening a chat that already has
 * messages never counts — the id must be the one the empty view showed — and only the user's own
 * question plays the transition: a system note (a model switch, Study) just ends the empty view.
 *
 * The result lives in a tiny external store set from the same chats listener, so it reaches React in
 * the same (sync) commit as the chats change itself (review F2/Q2): no frame with the plate gone or
 * reading «No messages yet», and the plate is the same node that then fades.
 */
function useFirstMessageLeave(chats: ChatsStore, reduced: boolean): LeaveState {
  const [store] = useState(() => createStore<LeaveState>(() => ({ leaving: null, bornHere: null })));
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  useEffect(() => {
    let shown = emptyViewOf(chats.getState());
    /** A chat created (not opened) while the new-chat view was on screen: the send's POST /kb/chats. */
    let created: string | null = null;
    let timer: number | undefined;
    const unsubscribe = chats.subscribe((s, prev) => {
      const next = emptyViewOf(s);
      if (shown === '') {
        const fresh = Object.keys(s.chats).find((id) => !prev.chats[id]?.chat && s.chats[id]?.chat?.messages.length === 0);
        if (fresh) created = fresh;
      }
      if (shown === '' && next && next === created) store.setState({ bornHere: next });
      if (shown && next === null && s.currentId === shown && s.chats[shown]?.chat?.messages[0]?.role === 'user') {
        const id = shown;
        store.setState({ leaving: id });
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { if (store.getState().leaving === id) store.setState({ leaving: null }); },
          reducedRef.current ? LEAVE_REDUCED_MS : LEAVE_MS);
      }
      shown = next;
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [chats, store]);
  return useStore(store);
}

/**
 * Centre column: one chat (decision 13) — header with ⋯, the conversation, the message field.
 * Streamed text is shown as it comes, never animated (decision 36).
 */
export function ChatView({ hidden }: { hidden: boolean }) {
  const { chats, settings } = useServices();
  const currentId = useChats((s) => s.currentId);
  const open = useChats((s) => (s.currentId ? s.chats[s.currentId] : undefined));
  const summary = useChats((s) => (s.currentId ? s.list.find((c) => c.id === s.currentId) : undefined));
  const openDoc = useOpenDocument();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState<{ id: string; what: string } | null>(null);
  const [notice, setNotice] = useNotice();
  /** Regenerate/Resume failed: the reason stays under that answer, by the button (QA D6). */
  const [actionError, setActionError] = useState<{ id: string; text: string } | null>(null);
  const agents = useAgents((s) => s.agents);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const reduced = useReducedMotion() ?? false;
  const { leaving, bornHere } = useFirstMessageLeave(chats, reduced);

  const chat = open?.chat ?? null;
  const questionActions = useQuestionActions(currentId, chat);
  const title = chat?.title ?? summary?.title ?? 'New chat';

  useEffect(() => {
    if (!currentId) return undefined;
    if (!chats.getState().chats[currentId]) void chats.getState().load(currentId);
    return chats.getState().follow(currentId);
  }, [chats, currentId, open?.load]);

  useEffect(() => {
    if (currentId && summary?.unread) void chats.getState().markRead(currentId);
  }, [chats, currentId, summary?.unread]);

  // A notice or an error belongs to the chat it was about (QA D10).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRenaming(false); stick.current = true; setNotice(null); setActionError(null); }, [currentId]);

  // Keep the newest text in view while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const act = async (message: KbMessage, what: 'regenerate' | 'resume' | 'save') => {
    if (!currentId) return;
    setBusy({ id: message.id, what });
    setActionError(null);
    const s = chats.getState();
    const res = what === 'regenerate' ? await s.regenerate(currentId, message.id)
      : what === 'resume' ? await s.resume(currentId, message.id) : await s.saveMessage(currentId, message.id);
    setBusy(null);
    if (!res.ok && what !== 'save') setActionError({ id: message.id, text: res.error });
    else if (!res.ok) setNotice(res.error);
    else if (what === 'save' && res.value) {
      // Decision 9: what was left out stays readable a little longer than a plain notice.
      setNotice(savedText(res.value), res.value.warning ? 10000 : undefined);
      openDoc({ type: 'page', id: res.value.id });
    }
  };

  // D-12: a diagram that can't be drawn asks this chat's agent for a fix — one message, only when
  // the user presses "Ask the agent to fix"; it is a normal question the user sees in the chat.
  // Decision 10: the request asks for the reply in the answer language (diagramFix.ts).
  const askDiagramFix = useCallback<DiagramFix>(async (source, error) => {
    if (!settings.getState().wiki.value) await settings.getState().loadWiki();
    const s = chats.getState();
    const messages = s.currentId ? s.chats[s.currentId]?.chat?.messages ?? [] : [];
    const language = fixLanguage(settings.getState().wiki.value, messages.some((m) => m.role === 'user'));
    const text = diagramFixRequest(source, error, language);
    const res = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [] }, {});
    return res.ok ? null : res.error;
  }, [chats, settings]);

  const recording = !!(chat?.recording_material_id ?? summary?.recording_material_id);
  const engine = chat?.engine ?? summary?.engine;
  const chatAgent = engine ? agentOf(agents, engine) : undefined;
  const fix = chatAgent && chatAgent.state !== 'ready' ? <AgentFix agent={chatAgent} /> : null;
  // FX §1: the field only behind an empty chat — none selected, or open with no messages yet —
  // and through the first message's burn-out. A chat that already has messages never shows it.
  const emptyView = !currentId || (!!chat && chat.messages.length === 0);
  const leavingHere = !!currentId && leaving === currentId;
  const showField = emptyView || leavingHere;
  // CHAT-BACKDROP-SPEC: a chat with messages has the backdrop instead — never both: it comes when the
  // first message's burn-out has ended, and moves only while an answer is being written.
  const showBackdrop = !showField && !!chat && chat.messages.length > 0;
  const newCopy = !currentId || (currentId === bornHere && !recording);
  const enter = leavingHere ? (reduced ? ' kb-chat__messages--fade' : ' kb-chat__messages--enter') : '';
  // F3: no text over the burning field — only the rising question until the burn-out ends; the
  // answer (and «Writing an answer…») appears once the thread is on its solid ground again.
  const messages = chat ? (leavingHere ? chat.messages.slice(0, 1) : chat.messages) : [];

  return (
    <section className="kb-center" data-pane="center" aria-label="Chat" hidden={hidden}>
      <header className="kb-head kb-head--chat">
        {renaming && chat ? (
          <RenameForm title={chat.title} onCancel={() => setRenaming(false)} onSave={async (next) => {
            const r = await chats.getState().rename(chat.id, next);
            if (!r.ok) return r.error;
            setRenaming(false);
            return null;
          }} />
        ) : (
          <h1 className="kb-head__title">{title}</h1>
        )}
        {recording && <span className="kb-tag kb-tag--static">during recording</span>}
        <span className="kb-head__spacer" />
        {chat && <WebSearchChip chatId={chat.id} messages={chat.messages} />}
        {summary && <ChatMenu chat={summary} onNotice={setNotice} onRename={() => setRenaming(true)} />}
      </header>
      {notice && <p className="kb-notice" role="status">{notice}</p>}
      <DitherStage className="kb-chat__stage" show={showField} leaving={leavingHere} active={!hidden} reduced={reduced}>
      {showBackdrop && <ChatBackdrop working={isAnswering(chat)} active={!hidden} reduced={reduced} />}
      <div className="kb-chat__scroll" ref={scrollRef} role="log" aria-label="Conversation" aria-live="off"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {currentId && open?.load === 'loading' && !chat && <div className="kb-chat__wait"><Spinner label="Opening the chat" /></div>}
        {currentId && open?.load === 'error' && !chat && (
          <Banner tone="error" title="Couldn’t open this chat."
            actions={<Button size="sm" variant="fill" icon="retry" onClick={() => void chats.getState().load(currentId)}>Try again</Button>}>
            {open.error}
          </Banner>
        )}
        {chat && chat.messages.length > 0 && (
          <DiagramFixProvider value={askDiagramFix}>
          <div className={`kb-chat__messages${enter}`}>
            {messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} message={m} actions={questionActions(m)} />
              : m.role === 'system' ? <SystemMessage key={m.id} chatId={chat.id} message={m} />
                : (
                  <AssistantMessage key={m.id} chatId={chat.id} message={m} actions={{
                    busy: busy?.id === m.id ? busy.what : null,
                    error: actionError?.id === m.id ? actionError.text : null,
                    fix,
                    onRegenerate: () => void act(m, 'regenerate'),
                    onResume: () => void act(m, 'resume'),
                    onSave: () => void act(m, 'save'),
                  }} />
                )))}
          </div>
          </DiagramFixProvider>
        )}
      </div>
      </DitherStage>
      {showField && (
        // FX §5: what the empty chat is for, on a solid plate above the field — never on the canvas.
        // An empty chat a recording opened (QA D9) says so instead of a blank page.
        <div className="kb-chat__plate" data-leaving={leavingHere ? 'true' : undefined} aria-hidden={leavingHere || undefined}>
          <p className="kb-chat__plate-title">{newCopy ? 'Ask about your materials' : recording ? 'Ask about the lecture' : 'No messages yet'}</p>
          <p className="kb-chat__plate-text">
            {newCopy
              ? 'Answers cite the exact moments of your recordings and the pages of your documents. Type @ to point at a page, a material or a chat.'
              : recording
                ? 'Questions here are answered from what has been recognised so far. Type @ to point at a page or a material.'
                : 'Ask about your materials. Type @ to point at a page, a material or a chat.'}
          </p>
        </div>
      )}
      <Composer chatId={currentId}
        placeholder={waitingHint(chat) ?? (recording ? 'Ask about the lecture · @ to reference' : 'Ask about your materials · @ to reference')} />
    </section>
  );
}
