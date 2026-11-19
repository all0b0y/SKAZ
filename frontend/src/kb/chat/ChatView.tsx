import { usePageVisible } from './usePageVisible';
import { useMotionLevel, useReducedMotion, useStillIndicators } from '../ui/motionLevel';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { KbMessage } from '../../api/kb/types.gen';
import { Banner, Button, Spinner } from '../ui';
import { Composer } from '../composer/Composer';
import { ExternalAttachmentDropOverlay, useExternalAttachmentBoundary } from '../composer/attachmentDrafts041/boundary';
import { NEW_CHAT_DRAFT } from '../composer/attachmentDrafts041/draft';
import { nativeAttachmentIntake } from '../composer/attachmentDrafts041/nativeIntake';
import { useAgents, useChats, useLibrary, usePrefs, useServices, useSettings } from '../state/context';
import { agentOf } from '../state/agents';
import { AgentFix } from './AgentFix';
import { useOpenDocument } from '../state/document';
import { ChatMenu, RenameForm } from './ChatMenu';
import { AssistantMessage, SystemMessage, UserMessage } from './Message';
import { DiscussPaperBar } from './DiscussPaperBar';
import { useQuestionActions } from './useQuestionActions';
import { isWaitingForUser, partsOf } from '../api/permissions';
import { WebSearchChip } from './webSearch';
import { ChatOverviewButton } from '../overview/ChatOverviewButton';
import { savedText } from './saved';
import type { KbChat } from '../../api/kb/types.gen';
import { chatWaits, isAnswering, isLocal, type ChatsData, type ChatsStore } from '../state/chats';
import { DitherStage } from '../fx/dither/DitherStage';
import { ChatBackdrop } from '../fx/backdrop/ChatBackdrop';
import { SelectionProvider } from './select/context';
import { useFollowSwitch } from './switchMotion';
import { ScrollEdges } from './ScrollEdges';
import { ReplyAnchorRail, ReturnToLatest, useReplyAnchors } from './replyAnchors041';
import { FindInChatPanel } from './findInChat041/FindInChatPanel';
import { useFindInChat } from './findInChat041/useFindInChat';
import { ChatTabStrip, ChatTabsEmptyState, useScopedReadingAnchor, type ChatTabItem } from '../shell/chatTabs041';

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

const acceptsAttachmentDrop = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('.kb-chat__workspace, .kb-composer');

const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

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
  const { chats, bridge, composer, library } = useServices();
  const currentId = useChats((s) => s.currentId);
  const openTabIds = useChats((s) => s.openTabIds);
  const lastClosedTabId = useChats((s) => s.lastClosedTabId);
  const allTabsClosed = useChats((s) => s.allTabsClosed);
  const list = useChats((s) => s.list);
  const openChats = useChats((s) => s.chats);
  const open = useChats((s) => (s.currentId ? s.chats[s.currentId] : undefined));
  const summary = useChats((s) => (s.currentId ? s.list.find((c) => c.id === s.currentId) : undefined));
  const sideOpen = usePrefs((s) => s.sideOpen);
  const openDoc = useOpenDocument();
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notice, setNotice] = useNotice();
  /** Regenerate/Resume failed: the reason stays under that answer, by the button (QA D6). */
  const [actionError, setActionError] = useState<{ id: string; text: string } | null>(null);
  const agents = useAgents((s) => s.agents);
  const scopeRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const reopenBtnRef = useRef<HTMLButtonElement | null>(null);
  const [reopenFocus, setReopenFocus] = useState<{ id: string | null; seq: number }>({ id: null, seq: 0 });
  const stick = useRef(true);
  /** B1 (decision 04): an explicit jump to a reply is still flying; see the onScroll guard. */
  const anchorFlight = useRef(false);
  const reduced = useReducedMotion() ?? false;
  const effectiveHidden = hidden || allTabsClosed;
  const { attachmentDrafts } = composer.getState();
  const draftId = currentId ?? NEW_CHAT_DRAFT;
  const sending = useStore(attachmentDrafts, (state) => state.getDraft(draftId).sending);
  const inbox = useLibrary((state) => state.folders.find((folder) => folder.system)?.id ?? null);
  const inWiki = useSettings((state) => state.wiki.value?.auto_add_files_links ?? true);
  const attachments = useExternalAttachmentBoundary({
    chatId: effectiveHidden || sending ? null : draftId,
    store: attachmentDrafts,
    intake: nativeAttachmentIntake(bridge.nativeIntake, inbox, () => { void library.getState().loadContent(); }),
    inWiki,
    acceptsTarget: acceptsAttachmentDrop,
  });
  const find = useFindInChat({ chatId: effectiveHidden ? null : currentId, scopeRef, scrollRef, reducedMotion: reduced });
  const findingChat = useRef<string | null>(null);
  // Decision 32: the main field is still only at «off» or the system's reduced motion; at «calm» it
  // keeps answering clicks and only its background drift stops.
  const fieldStill = useStillIndicators();
  const fieldCalm = useMotionLevel() === 'calm';
  const { leaving, bornHere } = useFirstMessageLeave(chats, reduced);
  const leavingHere = !!currentId && leaving === currentId;

  const chat = open?.chat ?? null;
  // B1 (decision 04): one stable anchor per assistant reply — the ordered ids the rail mirrors;
  // streaming grows an answer's text, never its id.
  const replyIds = useMemo(
    () => chat?.messages.flatMap((m) => (m.role === 'assistant' ? [m.id] : [])) ?? [],
    [chat?.messages],
  );
  // B1 (decision 04): the marker follows the reading position; only explicit navigation ever moves
  // the view. While the find panel is open A4 owns the viewport, and a hidden chat pane owns
  // nothing at all — both freeze the keys and the explicit jumps (the marker keeps following).
  const anchors = useReplyAnchors(scrollRef, replyIds, { reducedMotion: reduced, frozen: effectiveHidden || find.isOpen });
  // B1/A4 composition: the find's active match points into one reply — consumed as a notification
  // only. A4 owns exact-match scrolling, so B1 never queues a jump of its own, not even for a
  // repeated match inside the same reply; the marker syncs from the viewport as it stands.
  const searchInto = find.isOpen ? find.activeMatch?.messageId ?? null : null;
  const consumeSearch = anchors.consumeSearch;
  useLayoutEffect(() => { if (searchInto !== null) consumeSearch(searchInto); }, [searchInto, consumeSearch]);
  const questionActions = useQuestionActions(currentId, chat);
  const title = chat?.title ?? summary?.title ?? 'New chat';
  const tabItems = useMemo<ChatTabItem[]>(() => openTabIds.map((id) => {
    const itemSummary = list.find((c) => c.id === id);
    const itemChat = openChats[id]?.chat ?? null;
    const isActive = id === currentId && !allTabsClosed;
    const hasLocalStream = !!itemChat?.messages.some((m) => isLocal(m.id) && m.role === 'assistant' && m.state === 'streaming');
    return {
      id,
      title: (isActive ? itemChat?.title : itemSummary?.title) ?? itemSummary?.title ?? itemChat?.title ?? 'New chat',
      working: isActive && itemChat
        ? isAnswering(itemChat)
        : hasLocalStream || (itemSummary ? itemSummary.state === 'answering' : isAnswering(itemChat)),
      waiting: isActive && itemChat
        ? chatWaits(itemChat)
        : itemSummary
          ? isWaitingForUser(itemSummary)
          : itemChat
            ? chatWaits(itemChat)
            : false,
      unread: itemSummary?.unread ?? itemChat?.unread ?? false,
      pinned: (isActive ? itemChat?.pinned : itemSummary?.pinned) ?? itemSummary?.pinned ?? itemChat?.pinned ?? false,
    };
  }), [openTabIds, list, openChats, currentId, allTabsClosed]);
  const lastClosedTitle = useMemo(() => {
    if (!lastClosedTabId) return null;
    return list.find((c) => c.id === lastClosedTabId)?.title ?? openChats[lastClosedTabId]?.chat?.title ?? null;
  }, [lastClosedTabId, openChats, list]);
  // Decision 25: switching chats, the thread follows the tab's direction; the title crossfades.
  useFollowSwitch(currentId, effectiveHidden, scrollRef, titleRef);

  const readingAnchor = useScopedReadingAnchor({
    chatId: currentId,
    scrollRef,
    ready: !!chat && chat.messages.length > 0 && !leavingHere,
    hidden: effectiveHidden,
    pauseCapture: find.isOpen,
    stickRef: stick,
    defaultBottom: true,
    getAnchor: (id) => chats.getState().getReadingAnchor(id),
    setAnchor: (id, anchor) => chats.getState().setReadingAnchor(id, anchor),
  });
  const captureNowRef = useRef(readingAnchor.captureNow);
  captureNowRef.current = readingAnchor.captureNow;
  useEffect(() => chats.getState().registerBeforeSwitch((outgoingId) => {
    if (outgoingId) captureNowRef.current(outgoingId);
  }), [chats]);

  useEffect(() => {
    if (!currentId) return undefined;
    if (!chats.getState().chats[currentId]) void chats.getState().load(currentId);
    return chats.getState().follow(currentId);
  }, [chats, currentId, open?.load]);

  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!effectiveHidden && pageVisible && currentId && summary?.unread) void chats.getState().markRead(currentId);
  }, [chats, currentId, summary?.unread, effectiveHidden, pageVisible]);

  // A notice or an error belongs to the chat it was about (QA D10).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRenaming(false);
    stick.current = currentId ? (chats.getState().getReadingAnchor(currentId)?.stickToBottom ?? true) : true;
    anchorFlight.current = false;
    setNotice(null);
    setActionError(null);
  }, [currentId]);

  // B1 (decision 04): explicit navigation owns the reading position — a jump to a reply takes the
  // thread off the streaming bottom (the user is reading history). The return-to-latest button
  // queues no intent here: its landing's own scroll event re-sticks the thread.
  useLayoutEffect(() => {
    if (anchors.state.intent.kind === 'jumpToReply') { anchorFlight.current = true; stick.current = false; }
  }, [anchors.state.intent]);

  // Find controls the viewport until it restores the starting position on close.
  useLayoutEffect(() => {
    const closedFindHere = !effectiveHidden && findingChat.current !== null && findingChat.current === currentId && !find.isOpen;
    findingChat.current = find.isOpen ? currentId : null;
    const el = scrollRef.current;
    if (!el || find.isOpen) return;
    // B1: find gave the viewport back — any anchor flight from before it opened is over, and the
    // position A4 restored decides the stick again (A4 owns the restore; B1 clears only its guard).
    if (closedFindHere) { anchorFlight.current = false; stick.current = nearBottom(el); }
    else if (stick.current) el.scrollTop = el.scrollHeight;
  });

  const act = async (message: KbMessage, what: 'regenerate' | 'resume' | 'save') => {
    if (!currentId || busy[message.id]) return;
    setBusy((running) => ({ ...running, [message.id]: what }));
    setActionError(null);
    const s = chats.getState();
    const res = what === 'regenerate' ? await s.regenerate(currentId, message.id)
      : what === 'resume' ? await s.resume(currentId, message.id) : await s.saveMessage(currentId, message.id);
    setBusy((running) => {
      const next = { ...running };
      delete next[message.id];
      return next;
    });
    if (chats.getState().currentId !== currentId) return;
    if (!res.ok && what !== 'save') setActionError({ id: message.id, text: res.error });
    else if (!res.ok) setNotice(res.error);
    else if (what === 'save' && res.value) {
      // Decision 9: what was left out stays readable a little longer than a plain notice.
      setNotice(savedText(res.value), res.value.warning ? 10000 : undefined);
      openDoc({ type: 'page', id: res.value.id });
    }
  };

  const recording = !!(chat?.recording_material_id ?? summary?.recording_material_id);
  const discussFinding = chat?.discuss_finding ?? summary?.discuss_finding ?? null;
  const engine = chat?.engine ?? summary?.engine;
  const chatAgent = engine ? agentOf(agents, engine) : undefined;
  const fix = chatAgent && chatAgent.state !== 'ready' ? <AgentFix agent={chatAgent} /> : null;
  // FX §1: the field only behind an empty chat — none selected, or open with no messages yet —
  // and through the first message's burn-out. A chat that already has messages never shows it.
  const emptyView = !currentId || (!!chat && chat.messages.length === 0);
  const showField = emptyView || leavingHere;
  // CHAT-BACKDROP-SPEC: a chat with messages has the backdrop instead — never both: it comes when the
  // first message's burn-out has ended, and moves only while an answer is being written.
  const showBackdrop = !showField && !!chat && chat.messages.length > 0;
  const newCopy = !currentId || (currentId === bornHere && !recording);
  const enter = leavingHere ? (reduced ? ' kb-chat__messages--fade' : ' kb-chat__messages--enter') : '';
  // F3: no text over the burning field — only the rising question until the burn-out ends; the
  // answer (and «Writing an answer…») appears once the thread is on its solid ground again.
  const messages = chat ? (leavingHere ? chat.messages.slice(0, 1) : chat.messages) : [];

  const showTabs = openTabIds.length > 0 || allTabsClosed;

  return (
    <section ref={scopeRef} className="kb-center" data-pane="center" aria-label="Chat" hidden={hidden} {...attachments.paneHandlers}>
      <SelectionProvider chatId={currentId}>
      <header className="kb-head kb-head--chat">
        {renaming && chat ? (
          <>
            <RenameForm title={chat.title} onCancel={() => setRenaming(false)} onSave={async (next) => {
              const r = await chats.getState().rename(chat.id, next);
              if (!r.ok) return r.error;
              setRenaming(false);
              return null;
            }} />
            <span className="kb-head__spacer" />
          </>
        ) : showTabs ? (
          <>
            <ChatTabStrip
              tabs={tabItems}
              activeId={currentId}
              onSelect={(id) => {
                if (currentId && id !== currentId) readingAnchor.captureNow(currentId);
                chats.getState().selectTab(id);
              }}
              onClose={(id) => {
                if (id === currentId) readingAnchor.captureNow(currentId);
                chats.getState().closeTab(id);
              }}
              onEmptyFocus={() => reopenBtnRef.current?.focus({ preventScroll: true })}
              focusTabId={reopenFocus.id}
              focusSeq={reopenFocus.seq}
            />
            {!allTabsClosed && <h1 className="kb-visually-hidden" ref={titleRef}>{title}</h1>}
          </>
        ) : (
          <>
            <h1 className="kb-head__title" ref={titleRef}>{title}</h1>
            <span className="kb-head__spacer" />
          </>
        )}
        {recording && <span className="kb-tag kb-tag--static">during recording</span>}
        {chat && <WebSearchChip chatId={chat.id} messages={chat.messages} />}
        {chat && <ChatOverviewButton chatId={chat.id} />}
        {summary && <ChatMenu chat={summary} onNotice={setNotice} onRename={() => setRenaming(true)} />}
      </header>
      {notice && <p className="kb-notice" role="status">{notice}</p>}
      <div className="kb-chat__workspace" hidden={allTabsClosed}>
      <DitherStage className="kb-chat__stage" show={showField} leaving={leavingHere} active={!effectiveHidden} reduced={fieldStill} calm={fieldCalm}>
      {showBackdrop && <ChatBackdrop working={isAnswering(chat)} active={!effectiveHidden} reduced={reduced} />}
      <div className="kb-chat__scroll" ref={scrollRef} role="log" aria-label="Conversation" aria-live="off"
        data-anchors="true" tabIndex={currentId ? 0 : undefined}
        onScroll={(e) => {
          if (find.isOpen) return; // A4 owns the viewport while its panel is open.
          // B1 (decision 04 §7): the native scrollbar is gone (replyAnchors.css hooks this
          // attribute), scrolling itself is untouched. A reply jump that starts at the bottom
          // flies through the stick zone; its own events must not re-stick the thread mid-flight,
          // or the next streamed delta would snap the flight back to the bottom.
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (anchorFlight.current) { if (near) return; anchorFlight.current = false; }
          stick.current = near;
        }}>
        {currentId && open?.load === 'loading' && !chat && <div className="kb-chat__wait"><Spinner label="Opening the chat" /></div>}
        {currentId && open?.load === 'error' && !chat && (
          <Banner tone="error" title="Couldn’t open this chat."
            actions={<Button size="sm" variant="fill" icon="retry" onClick={() => void chats.getState().load(currentId)}>Try again</Button>}>
            {open.error}
          </Banner>
        )}
        {chat && chat.messages.length > 0 && (
          <div className={`kb-chat__messages${enter}`}>
            {messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} message={m} actions={questionActions(m)} />
              : m.role === 'system' ? <SystemMessage key={m.id} chatId={chat.id} message={m} />
                : (
                  <AssistantMessage key={m.id} chatId={chat.id} message={m} actions={{
                    busy: busy[m.id] ?? null,
                    error: actionError?.id === m.id ? actionError.text : null,
                    fix,
                    onRegenerate: () => void act(m, 'regenerate'),
                    onResume: () => void act(m, 'resume'),
                    onSave: () => void act(m, 'save'),
                    onCancelSave: async () => {
                      const res = await chats.getState().stop(chat.id, m.id);
                      if (!res.ok && chats.getState().currentId === chat.id) setNotice(res.error);
                    },
                  }} />
                )))}
          </div>
        )}
      </div>
      {/* Stage 6 B2 GradualBlur: soft edges under the title bar and above the composer (only over a thread). */}
      <ScrollEdges scrollRef={scrollRef} show={showBackdrop} />
      {/* B1 (decision 04): the dot column — one dot per model answer, the active one a longer
          dash; a click jumps to that answer and takes the thread off the streaming bottom. While
          the find panel is open A4 owns the viewport, so the click does nothing until it closes. */}
      <ReplyAnchorRail ids={anchors.state.ids} activeId={anchors.state.activeId}
        onGoToReply={(id) => { if (find.isOpen) return; anchorFlight.current = true; stick.current = false; anchors.goToReply(id); }} />
      {/* B1 (decision 04 §4): back to the newest message — only once the user left the bottom;
          its landing's scroll event re-sticks streaming (the explicit return, not a forced pull). */}
      <ReturnToLatest visible={anchors.state.showReturn} onReturn={anchors.returnToLatest} />
      <FindInChatPanel find={find} />
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
      {discussFinding && !discussFinding.material_id && (
        <DiscussPaperBar
          finding={discussFinding}
          onAdded={() => { if (currentId) void chats.getState().load(currentId); }}
          onOpenMaterial={(id) => openDoc({ type: 'material', id })}
          onNotice={setNotice}
        />
      )}
      </div>
      {allTabsClosed && (
        <ChatTabsEmptyState
          ref={reopenBtnRef}
          canReopen={lastClosedTabId !== null}
          lastClosedTitle={lastClosedTitle}
          sidebarHidden={!sideOpen}
          autoFocusReopen
          onReopenLast={() => {
            const reopened = chats.getState().reopenLastTab();
            if (reopened) setReopenFocus((f) => ({ id: reopened, seq: f.seq + 1 }));
          }}
          onNewChat={() => chats.getState().open(null)}
        />
      )}
      <Composer chatId={currentId} active={!effectiveHidden} handleImagePaste={attachments.handlePaste}
        placeholder={waitingHint(chat) ?? (recording ? 'Ask about the lecture · @ to reference' : 'Ask about your materials · @ to reference')} />
      <ExternalAttachmentDropOverlay visible={attachments.over} />
      </SelectionProvider>
    </section>
  );
}
