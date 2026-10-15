import { useCallback } from 'react';
import type { KbCitation } from '../../api/kb/types.gen';
import type { KbPageRef, KbSubjectRef } from '../api/b2';
import { useServices } from './context';

/**
 * The shared document navigator (API-B2 §6): every place that opens something on the right — a
 * source chip, a page chip, a notification, a ⌘K result — goes through `openDocument`. U3 renders
 * the panels themselves; U2 only navigates. `quote` is the exact checked quote to highlight.
 */
export interface DocRef {
  type: 'page' | 'material';
  id: string;
  block_id?: string | null;
  seg?: number | null;
  quote?: string | null;
}

export const citationRef = (c: KbCitation): DocRef => ({ type: 'material', id: c.material_id, seg: c.seg, quote: c.quote ?? null });
export const pageRef = (p: KbPageRef, blockId?: string | null): DocRef => ({ type: 'page', id: p.id, block_id: blockId ?? null });
export const subjectRef = (s: KbSubjectRef): DocRef | null =>
  s.type === 'chat' ? null : { type: s.type, id: s.id, block_id: s.block_id ?? null, seg: s.seg ?? null };

export function useOpenDocument(): (ref: DocRef) => void {
  const { ui } = useServices();
  return useCallback((ref: DocRef) => ui.getState().openDocument(ref), [ui]);
}
