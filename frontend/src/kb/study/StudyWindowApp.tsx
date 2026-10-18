import { useEffect, useMemo, useRef } from 'react';
import type { StudyWindowTarget } from '../../api/bridge';
import { EmptyState, Spinner } from '../ui';
import { MotionProvider } from '../ui/motion';
import { KbServicesProvider, createServices, useChats, usePrefs, useServices, type KbBridge } from '../state/context';
import { Composer } from '../composer/Composer';
import { AssistantMessage, SystemMessage, UserMessage } from '../chat/Message';
import { StudyBlock } from './StudyBlock';
import { useStudyPart } from './useStudy';

/** Messages of the chat shown under the block: the latest few, the conversation itself stays in the main window. */
const MINI_THREAD = 6;

function ThemeSync() {
  const theme = usePrefs((s) => s.theme);
  const textSize = usePrefs((s) => s.textSize);
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.kbUi = '';
    if (theme === 'system') delete html.dataset.theme;
    else html.dataset.theme = theme;
    html.dataset.textSize = textSize;
  }, [theme, textSize]);
  return null;
}

function StudyWindow({ target }: { target: StudyWindowTarget }) {
  const { chats, agents, bridge } = useServices();
  const { chatId, studyId } = target;
  const open = useChats((s) => s.chats[chatId]);
  const part = useStudyPart(chatId, studyId);
  const seenHere = useRef(false);

  useEffect(() => {
    chats.getState().open(chatId);
    void agents.getState().refresh();
  }, [chats, agents, chatId]);
  useEffect(() => (open?.chat ? chats.getState().follow(chatId) : undefined), [chats, chatId, open?.chat ? 1 : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = part ? `${part.title} — SKAZ` : 'SKAZ'; }, [part?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  // The block went back into the chat or beside it (from either window): this window closes.
  useEffect(() => {
    if (part?.place === 'window') seenHere.current = true;
    else if (part && seenHere.current) void bridge.closeStudyWindow?.();
  }, [part, bridge]);

  const messages = open?.chat?.messages ?? [];
  const recent = useMemo(() => messages.slice(-MINI_THREAD), [messages]);
  return (
    <div className="kb-stw">
      <div className="kb-stw__bar" aria-hidden="true">{part?.title ?? 'SKAZ'}</div>
      <div className="kb-stw__block">
        {part ? <StudyBlock chatId={chatId} part={part} where="window" />
          : open?.load === 'error' ? <EmptyState icon="chats" title="This chat isn’t available" compact>{open.error}</EmptyState>
            : open?.chat ? <EmptyState icon="wiki" title="This block isn’t in the chat any more" compact>Close this window.</EmptyState>
              : <Spinner label="Opening the block" />}
      </div>
      <section className="kb-stw__chat" aria-label="Chat">
        <div className="kb-stw__thread">
          {recent.map((m) => (m.role === 'user' ? <UserMessage key={m.id} message={m} />
            : m.role === 'system' ? <SystemMessage key={m.id} chatId={chatId} message={m} />
              : (
                <AssistantMessage key={m.id} chatId={chatId} message={m} actions={{
                  busy: null,
                  onRegenerate: () => void chats.getState().regenerate(chatId, m.id),
                  onResume: () => void chats.getState().resume(chatId, m.id),
                  onSave: () => void chats.getState().saveMessage(chatId, m.id),
                }} />
              )))}
        </div>
        <div className="kb-stw__composer">
          <Composer chatId={chatId} placeholder={part?.kind === 'test' ? 'Ask about this question…' : 'Ask about this card…'} />
        </div>
      </section>
    </div>
  );
}

/**
 * A deck or test block in a window of its own (W2): the block on top, the same chat below — its
 * latest messages and a message field. Only the backend requests and closing itself reach main
 * from here; the library, recording and file dialogs stay with the main window.
 */
export function StudyWindowApp({ target, bridge }: { target: StudyWindowTarget; bridge: KbBridge }) {
  const services = useMemo(() => createServices({
    request: bridge.request, closeStudyWindow: bridge.closeStudyWindow, studyWindow: target,
  }), [bridge, target]);
  return (
    <KbServicesProvider services={services}>
      <MotionProvider>
        <ThemeSync />
        <StudyWindow target={target} />
      </MotionProvider>
    </KbServicesProvider>
  );
}
