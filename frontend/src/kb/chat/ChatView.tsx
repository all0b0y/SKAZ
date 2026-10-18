import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KbMessage } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Spinner } from '../ui';
import { Composer } from '../composer/Composer';
import { useAgents, useChats, useServices } from '../state/context';
import { agentOf } from '../state/agents';
import { AgentFix } from './AgentFix';
import { useOpenDocument } from '../state/document';
import { ChatMenu, RenameForm } from './ChatMenu';
import { AssistantMessage, SystemMessage, UserMessage } from './Message';
import { partsOf } from '../api/permissions';
import type { KbChat } from '../../api/kb/types.gen';

/** What waits for the user in this chat, for the message field's hint (P4, Q-A2): nothing blocks typing. */
function waitingHint(chat: KbChat | null): string | null {
  const parts = chat?.messages.flatMap((m) => partsOf(m)) ?? [];
  if (parts.some((p) => p.type === 'question' && p.status === 'pending')) return 'Pick an option above, or just type…';
  if (parts.some((p) => p.type === 'permission' && p.status === 'pending')) return 'You can keep typing — the request waits';
  return null;
}

function useNotice(): [string | null, (text: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [notice, (text: string | null) => {
    setNotice(text);
    window.clearTimeout(timer.current);
    if (text !== null) timer.current = window.setTimeout(() => setNotice(null), 5000);
  }];
}

/**
 * Centre column: one chat (decision 13) — header with ⋯, the conversation, the message field.
 * Streamed text is shown as it comes, never animated (decision 36).
 */
export function ChatView({ hidden }: { hidden: boolean }) {
  const { chats } = useServices();
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

  const chat = open?.chat ?? null;
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
      setNotice(`Saved to the wiki as “${res.value.title}”.`);
      openDoc({ type: 'page', id: res.value.id });
    }
  };

  const recording = !!(chat?.recording_material_id ?? summary?.recording_material_id);
  const engine = chat?.engine ?? summary?.engine;
  const chatAgent = engine ? agentOf(agents, engine) : undefined;
  const fix = chatAgent && chatAgent.state !== 'ready' ? <AgentFix agent={chatAgent} /> : null;

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
        {summary && <ChatMenu chat={summary} onNotice={setNotice} onRename={() => setRenaming(true)} />}
      </header>
      {notice && <p className="kb-notice" role="status">{notice}</p>}
      <div className="kb-chat__scroll" ref={scrollRef} role="log" aria-label="Conversation" aria-live="off"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {!currentId && (
          <EmptyState icon="chats" title="Ask about your materials">
            Answers cite the exact moments of your recordings and the pages of your documents. Type @ to point at a page, a material or a chat.
          </EmptyState>
        )}
        {currentId && open?.load === 'loading' && !chat && <div className="kb-chat__wait"><Spinner label="Opening the chat" /></div>}
        {currentId && open?.load === 'error' && !chat && (
          <Banner tone="error" title="Couldn’t open this chat."
            actions={<Button size="sm" variant="fill" icon="retry" onClick={() => void chats.getState().load(currentId)}>Try again</Button>}>
            {open.error}
          </Banner>
        )}
        {chat && chat.messages.length === 0 && (
          // An empty chat (one a recording opened, QA D9) says what it is for instead of a blank page.
          <EmptyState icon="chats" title={recording ? 'Ask about the lecture' : 'No messages yet'}>
            {recording
              ? 'Questions here are answered from what has been recognised so far. Type @ to point at a page or a material.'
              : 'Ask about your materials. Type @ to point at a page, a material or a chat.'}
          </EmptyState>
        )}
        {chat && chat.messages.length > 0 && (
          <div className="kb-chat__messages">
            {chat.messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} message={m} />
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
        )}
      </div>
      <Composer chatId={currentId}
        placeholder={waitingHint(chat) ?? (recording ? 'Ask about the lecture · @ to reference' : 'Ask about your materials · @ to reference')} />
    </section>
  );
}
