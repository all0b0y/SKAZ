import { useState } from 'react';
import type { KbMessagePart } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { rendererOf } from './blocks/registry';

/** A declaration or a validated item's explicit basis, never a guess from missing citations. */
export function usesGeneralKnowledge(parts: readonly KbMessagePart[]): boolean {
  return parts.some((part) => part.type === 'knowledge' || (part.type === 'answer_block'
    && part.state === 'ready' && part.block && rendererOf(part.block).items(part.block).some((item) => item.agent)));
}

/** Same quiet disclosure pattern as web results, without permissions, tools or a made-up clock. */
export function KnowledgeNotice() {
  const [open, setOpen] = useState(false);
  return (
    <div className="kb-knowledge" role="note" aria-label="Using general knowledge">
      <button type="button" className="kb-web-fold" aria-label="Using general knowledge"
        aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="analysis" size={14} /><b>Using general knowledge</b>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      {open && <div className="kb-knowledge__detail">
        Some explanations or examples use the model’s general knowledge, not evidence from your materials.
        Material-backed claims keep their source links; web evidence has its own external links.
      </div>}
    </div>
  );
}
