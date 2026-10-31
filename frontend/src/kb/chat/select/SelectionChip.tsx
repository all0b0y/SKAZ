import { useReducedMotion } from '../../ui/motionLevel';
import { useState } from 'react';

import type { KbSelection } from '../../../api/kb/types.gen';
import { Icon } from '../../ui';
import { flashItems } from './items';
import { chipLabel } from './model';

/** The block of an earlier answer a selection points at, if it is still on the screen. */
function findBlock(selection: KbSelection): HTMLElement | null {
  const answer = Array.from(document.querySelectorAll<HTMLElement>('.kb-msg--assistant[data-message-id]'))
    .find((el) => el.dataset.messageId === selection.message_id);
  return Array.from(answer?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])
    .find((el) => el.dataset.blockId === selection.block_id) ?? null;
}

/**
 * P2 decision 3: «📍 …» on a question asked about a selection. A click scrolls to the earlier answer
 * and lights the picked items there for a moment; the answer itself never changes.
 */
export function SelectionChip({ selection }: { selection: KbSelection }) {
  const reduced = useReducedMotion() ?? false;
  const [gone, setGone] = useState(false);
  const label = chipLabel({ items: selection.items, title: selection.title ?? null, kind: selection.kind });
  const show = () => {
    const block = findBlock(selection);
    setGone(!block);
    if (!block) return;
    block.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    flashItems(block, selection.items.map((i) => i.id));
  };
  return (
    <button type="button" className="kb-selchip" onClick={show}
      aria-label={`Show the selection in the answer: ${label}`}
      title={gone ? 'That answer is no longer in this chat' : selection.items.map((i) => i.label).join('; ')}>
      <Icon name="pin" size={12} />
      <span className="kb-selchip__label">{label}</span>
    </button>
  );
}
