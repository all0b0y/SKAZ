import type { KbMaterialOverlap } from '../../api/kb/types.gen';
import { useUi } from '../state/context';

/**
 * N2 decision 1(1): one quiet line at the material once it is in the wiki — "About 70% of this is
 * already in your wiki: RAG, Self-check loops · what's new: section 4". Computed by the backend from
 * the merged repeats; each page opens. Not a notification, never blocking; nothing when nothing repeats.
 */
export function OverlapLine({ overlap }: { overlap: KbMaterialOverlap | null | undefined }) {
  const openDocument = useUi((s) => s.openDocument);
  if (!overlap || overlap.repeated === 0) return null;
  return (
    <p className="kb-mat__note" data-testid="material-overlap">
      {`About ${overlap.percent}% of this is already in your wiki: `}
      {overlap.pages.map((page, i) => (
        <span key={page.id}>
          {i > 0 && ', '}
          <button type="button" className="kb-linkbtn" onClick={() => openDocument({ type: 'page', id: page.id })}>{page.title}</button>
        </span>
      ))}
      {overlap.new_sections.length > 0 && ` · what’s new: ${overlap.new_sections.join(', ')}`}
    </p>
  );
}
