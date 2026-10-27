import { useEffect, useRef, useState } from 'react';
import type { KbChatSummary } from '../../api/kb/types.gen';
import { Tooltip } from '../ui/Tooltip';
import { useStillIndicators } from '../ui/motionLevel';
import { FxCanvas } from '../fx/FxCanvas';
import { CONNECT_STILL_T, MARK_EDGES, MARK_NODES, drawConnectGraph, drawMarkResolve } from '../fx/indicators/connect';
import { isWaitingForUser } from '../api/permissions';

/** A permission or a question waits in this chat (0.3.1 P4): said in words, with a dot. */
export function WaitingMark() {
  return <span className="kb-chatwait" data-testid="chat-waiting">Waiting for you</span>;
}

/**
 * What a chat row shows after its title (decision 26):
 * - `waiting` — «Waiting for you» keeps priority and its look;
 * - `none` for the open (bridged) chat — the thread shows the work, the bridge stays clean;
 * - `answering` — the «Connecting nodes» mark;
 * - `finishing` — the answer just arrived: the nodes pull into the «new» dot (once per transition);
 * - `new` — an unread answer (the still dot);
 * - `none` otherwise.
 */
export type ChatMarkKind = 'waiting' | 'answering' | 'finishing' | 'new' | 'none';

export function chatMarkKind(chat: KbChatSummary, current: boolean, finishing: boolean): ChatMarkKind {
  if (isWaitingForUser(chat)) return 'waiting';
  if (current) return 'none';
  if (chat.state === 'answering') return 'answering';
  if (chat.unread) return finishing ? 'finishing' : 'new';
  return 'none';
}

/** How long the finish plays: the pull (0.5 s), the fade (to 0.6 s), the dot's pop (0.55 + 0.24 s). */
export const FINISH_MS = 800;

/**
 * True for {@link FINISH_MS} after this chat went from answering to done while unread and not open.
 * Never on mount (a chat that was already done shows the plain dot), never for the open chat, and not
 * when indicators are still (motion off or the system's reduced motion): then the dot just appears.
 */
export function useAnswerFinish(chat: KbChatSummary, current: boolean): boolean {
  const still = useStillIndicators();
  const answering = chat.state === 'answering';
  const was = useRef(answering);
  const [finishing, setFinishing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const before = was.current;
    was.current = answering;
    if (!before || answering || current || !chat.unread || still) return;
    setFinishing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFinishing(false), FINISH_MS);
  }, [answering, current, chat.unread, still]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Opening the chat (or the mark leaving its state) ends the finish at once.
  return finishing && !current && !answering;
}

function NodesMark() {
  const still = useStillIndicators();
  return (
    <FxCanvas className="kb-chatmark__fx" dpr={2} active reduced={still} stillT={CONNECT_STILL_T}
      onFrame={(ctx, _w, _h, t, _dt, colors) => drawConnectGraph(ctx, t, colors, MARK_NODES, MARK_EDGES)} />
  );
}

/** The marks after a chat row's title (decision 26). No effect on the row's edges anywhere. */
export function ChatMark({ chat, current }: { chat: KbChatSummary; current: boolean }) {
  const finishing = useAnswerFinish(chat, current);
  const kind = chatMarkKind(chat, current, finishing);
  if (kind === 'waiting') return <WaitingMark />;
  if (kind === 'answering') {
    return (
      <Tooltip text="Agent is answering" describes>
        <span className="kb-chatmark kb-chatmark--answering" role="img" aria-label="answering" data-mark="answering"><NodesMark /></span>
      </Tooltip>
    );
  }
  if (kind === 'finishing') {
    return (
      <span className="kb-chatmark kb-chatmark--finishing" role="img" aria-label="new answer" data-mark="finishing">
        <FxCanvas className="kb-chatmark__fx" dpr={2} active reduced={false}
          onFrame={(ctx, _w, _h, t, _dt, colors) => drawMarkResolve(ctx, t, colors)} />
        <span className="kb-chatmark__late" aria-hidden="true" />
      </span>
    );
  }
  if (kind === 'new') return <span className="kb-chatmark kb-chatmark--new" role="img" aria-label="new answer" data-mark="new" />;
  return null;
}
