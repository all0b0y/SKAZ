import type { ReactNode } from 'react';
import type { KbCitation, KbPageRef, PageKind } from '../api/b2-u3';
import { Chip, IconButton, type IconName } from '../ui';
import { formatTime, folderTone } from '../library/materialMeta';
import { useLibrary, useUi } from '../state/context';

export const PAGE_KIND_LABEL: Record<PageKind, string> = {
  concept: 'Concept',
  note: 'Notes',
  analysis: 'Analysis',
  folder: 'Folder',
};

export const PAGE_KIND_ICON: Record<PageKind, IconName> = {
  concept: 'concept',
  note: 'pdf',
  analysis: 'models',
  folder: 'folder',
};

/**
 * "Ask about this" from a page or a material. The chat and its composer are U2's: this posts a
 * window event the composer listens to (`kb:ask-about`, detail = {type, id, title}).
 */
export function askAbout(detail: { type: 'page' | 'material'; id: string; title: string }) {
  window.dispatchEvent(new CustomEvent('kb:ask-about', { detail }));
}

/** Source chip of a claim: opens the material at the fragment with the exact quote marked. */
export function CitationChip({ citation, showTitle = true }: { citation: KbCitation; showTitle?: boolean }) {
  const openDocument = useUi((s) => s.openDocument);
  const title = citation.material_title ?? 'Source';
  const meta = citation.start_ms !== null ? formatTime(citation.start_ms) : citation.page !== null ? `p. ${citation.page}` : undefined;
  if (!citation.available) {
    return <Chip kind={citation.start_ms !== null ? 'recording' : 'document'} label={`${title} (removed)`} meta={meta} />;
  }
  return (
    <Chip
      kind={citation.start_ms !== null ? 'recording' : 'document'}
      label={showTitle ? title : ''}
      meta={meta}
      onClick={() => openDocument({ type: 'material', id: citation.material_id, seg: citation.seg, quote: citation.quote ?? null })}
    />
  );
}

export function PageChip({ page }: { page: KbPageRef }) {
  const openDocument = useUi((s) => s.openDocument);
  return <Chip kind="wiki" label={page.title} onClick={() => openDocument({ type: 'page', id: page.id })} />;
}

/** Folder colour by the folder's place among user folders (Inbox and unknown folders: none). */
export function useFolderTone(): (folderId: string | null | undefined) => string | undefined {
  const folders = useLibrary((s) => s.folders);
  return (folderId) => {
    const user = folders.filter((f) => !f.system);
    const i = user.findIndex((f) => f.id === folderId);
    return i >= 0 ? folderTone(i) : undefined;
  };
}

export function FolderTag({ name, tone }: { name: string; tone?: string }) {
  return (
    <span className="kb-ftag">
      <span className="kb-fdot" style={{ background: tone ?? 'var(--kb-line)' }} aria-hidden="true" />
      {name}
    </span>
  );
}

/** ⤢ and ✕ of the right panel; the labels are the ones the shell smoke drives. */
export function PanelFrameButtons({ closeLabel = 'Close document', expandable = true, children, more }: {
  closeLabel?: string;
  expandable?: boolean;
  children?: ReactNode;
  /** The ⋯ menu, placed between ⤢ and ✕ (v39 order). */
  more?: ReactNode;
}) {
  const expanded = useUi((s) => s.docExpanded);
  const toggle = useUi((s) => s.toggleDocExpanded);
  const close = useUi((s) => s.closeDoc);
  return (
    <>
      {children}
      {expandable && (
        <IconButton
          icon={expanded ? 'collapse' : 'expand'}
          label={expanded ? 'Back to side panel' : 'Expand to the centre'}
          aria-pressed={expanded}
          onClick={toggle}
        />
      )}
      {more}
      <IconButton icon="close" label={closeLabel} onClick={close} />
    </>
  );
}
