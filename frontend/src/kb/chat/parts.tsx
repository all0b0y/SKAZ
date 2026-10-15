import { useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import type { KbCitation, KbConnectionFolder, KbMessagePart, KbPageRef } from '../../api/kb/types.gen';
import { Chip, Icon } from '../ui';
import { EXIT, SPRING_SMALL } from '../ui/motion';
import { clock } from '../ui/time';
import { citationRef, pageRef, useOpenDocument } from '../state/document';
import { useLibrary } from '../state/context';

/** Source chip (▶ recording · time / document · page): opens the material on the right. */
export function CiteChip({ citation }: { citation: KbCitation }) {
  const open = useOpenDocument();
  const kind = citation.start_ms !== null ? 'recording' : 'document';
  const meta = citation.start_ms !== null ? clock(citation.start_ms) : citation.page !== null ? `p. ${citation.page}` : undefined;
  const label = citation.material_title ?? 'Source';
  if (!citation.available) {
    return <span className="kb-chip is-gone" role="note" aria-label={`${label}: no longer available`}><Icon name="error" size={12} />{label}</span>;
  }
  return <Chip kind={kind} label={label} meta={meta} onClick={() => open(citationRef(citation))} />;
}

/** Wiki page chip: opens the page on the right. */
export function PageChip({ page, blockId }: { page: KbPageRef; blockId?: string | null }) {
  const open = useOpenDocument();
  return <Chip kind="wiki" label={page.title} onClick={() => open(pageRef(page, blockId))} />;
}

export function InlinePart({ part }: { part: KbMessagePart }): ReactNode {
  if (part.type === 'cite') return <CiteChip citation={part.citation} />;
  if (part.type === 'page') return <PageChip page={part.page} blockId={part.block_id} />;
  return null;
}

/** Colour of a folder by its place in the library (four folder colours, never the only cue). */
export function useFolderTone(): (folderId: string) => number {
  const folders = useLibrary((s) => s.folders);
  return (folderId) => {
    const own = folders.filter((f) => !f.system);
    const i = own.findIndex((f) => f.id === folderId);
    return ((i < 0 ? hash(folderId) : i) % 4) + 1;
  };
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * "Connection · N folders" (v4): folded into one pill; unfolded — a row per folder with its
 * formula/claim and source chip, the last row the agent's inference (italic, labelled) and the page.
 */
export function ConnectionBlock({ folders, inference, page }: { folders: KbConnectionFolder[]; inference: string; page: KbPageRef | null }) {
  const [open, setOpen] = useState(false);
  const tone = useFolderTone();
  const n = folders.length;
  return (
    <div className="kb-conn">
      <button type="button" className="kb-conn__pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="graph" size={13} />
        <span className="kb-conn__dots" aria-hidden="true">
          {folders.slice(0, 4).map((f) => <i key={f.folder_id} className={`kb-fdot kb-fdot--${tone(f.folder_id)}`} />)}
        </span>
        Connection · {n} {n === 1 ? 'folder' : 'folders'}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.ul className="kb-conn__rows" aria-label="Connection across folders"
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }} exit={{ opacity: 0, transition: EXIT }}>
            {folders.map((f, i) => (
              <m.li key={`${f.folder_id}-${i}`} className="kb-conn__row"
                initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { ...SPRING_SMALL, delay: 0.03 * i } }}>
                <i className={`kb-fdot kb-fdot--${tone(f.folder_id)}`} aria-hidden="true" />
                <span className="kb-conn__folder" title={f.folder_name}>{f.folder_name}</span>
                <span className="kb-conn__text">{f.text}</span>
                <CiteChip citation={f.citation} />
              </m.li>
            ))}
            <m.li className="kb-conn__row kb-conn__row--inference"
              initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { ...SPRING_SMALL, delay: 0.03 * n } }}>
              <span className="kb-conn__text"><span className="kb-conn__label">Agent inference:</span> {inference}</span>
              {page && <PageChip page={page} />}
            </m.li>
          </m.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
