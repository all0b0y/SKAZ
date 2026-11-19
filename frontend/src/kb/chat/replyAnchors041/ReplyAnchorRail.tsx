/*
 * B1 — SKAZ 0.4.1, decision 04: the thin dot column beside the chat — one dot per assistant
 * reply, the active one a longer dash, the row widening into a comfortable hit zone on hover and
 * keyboard focus (approved mock `.dev/task-context/navigation-mockup.html`). The dots are
 * markers, not a scrollbar replacement: trackpad, wheel and ↑/↓ keep working.
 */

import type { ReplyId } from './replyAnchors';

export interface ReplyAnchorRailProps {
  /** The ordered assistant reply ids; each becomes one dot, in order. */
  ids: readonly ReplyId[];
  /** The reply the user is reading: its dot is the longer dash and carries `aria-current`. */
  activeId: ReplyId | null;
  onGoToReply: (id: ReplyId) => void;
  /** The rail's accessible name; defaults to the mock's «Answers in this chat». */
  label?: string;
}

export function ReplyAnchorRail({ ids, activeId, onGoToReply, label = 'Answers in this chat' }: ReplyAnchorRailProps) {
  if (ids.length === 0) return null;
  return (
    <nav className="kb-anchor-rail" aria-label={label}>
      {ids.map((id, i) => (
        <button key={id} type="button" className="kb-anchor-dot"
          data-active={activeId === id ? 'true' : 'false'}
          aria-current={activeId === id ? 'true' : undefined}
          aria-label={`Go to model answer ${i + 1}`}
          title={`Model answer ${i + 1}${activeId === id ? ' · current' : ''}`}
          onClick={() => onGoToReply(id)} />
      ))}
    </nav>
  );
}
