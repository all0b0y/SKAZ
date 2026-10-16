import { useCallback, useEffect, type ReactNode } from 'react';
import type { KbCitation, KbPageRef } from '../../api/kb/types.gen';
import type { PageKind } from '../api/names';
import { Chip, IconButton, type IconName } from '../ui';
import { formatTime, folderTone } from '../library/materialMeta';
import { useLibrary, useServices, useUi } from '../state/context';

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
 * "Ask about this" from a page or a material: the page/material becomes an @-token in the message
 * field of the current chat (the composer bus, like "Ask agent about this" of a decision), the chat
 * comes back to the centre if a list or the expanded document had it, and the field takes focus.
 */
export function useAskAbout(): (ref: { type: 'page' | 'material'; id: string; title: string }) => void {
  const { ui, composer } = useServices();
  return useCallback((ref) => {
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    if (s.docExpanded) s.toggleDocExpanded();
    composer.getState().push([{ kind: 'mention', ref }], { focus: true });
  }, [ui, composer]);
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
  // The page's own type icon: a folder overview reads as a folder, Notes as notes (QA C12).
  return <Chip kind="wiki" icon={PAGE_KIND_ICON[page.kind]} label={page.title} onClick={() => openDocument({ type: 'page', id: page.id })} />;
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

/** ← (when there is somewhere to go back to), ⤢ and ✕ of the right panel; the labels are the ones the shell smoke drives. */
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
  const canGoBack = useUi((s) => s.docHistory.length > 0);
  const goBack = useUi((s) => s.goBack);
  // ⌘[ (QA C20): back to what the panel showed before, e.g. the page after "Open at quote".
  useEffect(() => {
    if (!canGoBack) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key !== '[') return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canGoBack, goBack]);
  return (
    <>
      {canGoBack && <IconButton icon="chevronLeft" label="Back" aria-keyshortcuts="Meta+BracketLeft" className="kb-head__back" onClick={goBack} />}
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
