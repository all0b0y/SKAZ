import type { RightView } from '../state/document';
import { PageView } from '../wiki/PageView';
import { MaterialView } from '../material/MaterialView';
import { GraphPanel } from '../graph/GraphPanel';
import { LivePanel } from '../recording/LivePanel';
import { WikiFileView } from '../wiki/WikiFileView';
import { PermissionReview } from '../chat/PermissionReview';

const LABEL: Record<RightView['kind'], string> = {
  doc: 'Document',
  graph: 'Graph of connections',
  live: 'Live recording',
  wikifile: 'Document',
  review: 'Review',
};

/**
 * Right panel: exists only while something is open (decision 13). It shows a wiki page or a
 * material (`openDocument`), the graph (wide), or the live transcript of a recording.
 * ⤢ gives it the centre instead of the chat, ✕ closes it. Each view brings its own header.
 */
export function DocPanel({ view, expanded, width }: { view: RightView; expanded: boolean; width: number }) {
  return (
    <aside
      id="kb-doc"
      className={`kb-doc kb-doc--${view.kind}${expanded ? ' is-expanded' : ''}`}
      data-pane="doc"
      data-state={expanded ? 'expanded' : 'open'}
      data-view={view.kind === 'doc' ? view.target.type : view.kind}
      aria-label={LABEL[view.kind]}
      style={expanded ? undefined : { width }}
    >
      {view.kind === 'doc' && view.target.type === 'page' && <PageView key={view.target.id} target={view.target} nonce={view.nonce} />}
      {view.kind === 'doc' && view.target.type === 'material' && <MaterialView key={view.target.id} target={view.target} nonce={view.nonce} />}
      {view.kind === 'graph' && <GraphPanel />}
      {view.kind === 'live' && <LivePanel materialId={view.materialId} />}
      {view.kind === 'wikifile' && <WikiFileView key={view.name} name={view.name} />}
      {view.kind === 'review' && <PermissionReview key={view.partId} chatId={view.chatId} partId={view.partId} />}
    </aside>
  );
}
