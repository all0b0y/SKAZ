import type { RefObject } from 'react';
import { Icon, IconButton, Popover } from '../ui';
import type { Placement } from '../ui/geometry';
import { useUi } from '../state/context';
import { PAGE_KIND_ICON } from '../document/parts';
import { BUDGET_PAUSED_LABEL, Pill } from '../material/StatusChips';
import { WIKI_LEGEND, type WikiTerm } from '../settings/wikiTerms';
import { ClaimLabel } from './ClaimLabel';

export const WIKI_LEGEND_TITLE = 'What the wiki labels mean';

/** A term drawn as the wiki draws it: the real label, icon, number mark or pill. */
function Sample({ term }: { term: WikiTerm }) {
  const s = term.sample;
  switch (s.type) {
    case 'page':
      return <span className="kb-legend__kind"><Icon name={PAGE_KIND_ICON[s.kind]} size={14} />{term.name}</span>;
    case 'claim':
      return <ClaimLabel kind={s.kind} edited={s.edited} />;
    case 'source-number':
      // The citation mark of a statement (cite/SourceMarks.tsx), drawn still.
      return <span className="kb-legend__text">text<span className="kb-cns"><span className="kb-cn">1</span></span></span>;
    case 'recheck':
      return <span className="kb-legend__kind"><Icon name="retry" size={14} />Re-check</span>;
    case 'paused':
      return <Pill tone="warn" icon="warning">{BUDGET_PAUSED_LABEL}</Pill>;
    case 'text':
    default:
      return <span className="kb-legend__kind">{term.name}</span>;
  }
}

/**
 * The wiki legend (wiki-terms v1, variant A): a popover anchored to its trigger — “?” on a wiki page,
 * on the Wiki panel, or “Show…” in Settings → Wiki → Help. 15 labels in 3 groups, one line each.
 */
export function WikiLegend({ open, onClose, anchorRef, placement = 'bottom-end' }: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
}) {
  const openSettings = useUi((s) => s.openSettings);
  const go = (section: 'wiki' | 'models') => { onClose(); openSettings(section); };
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} label={WIKI_LEGEND_TITLE} placement={placement}
      scope="window" className="kb-legend">
      <div className="kb-legend__head">
        <h2 className="kb-legend__title">{WIKI_LEGEND_TITLE}</h2>
        <IconButton icon="close" size="sm" label="Close" onClick={() => {
          onClose();
          anchorRef.current?.focus({ preventScroll: true });
        }} />
      </div>
      {WIKI_LEGEND.map((group) => (
        <section key={group.title} className="kb-legend__group" data-legend-group={group.title}>
          <h3 className="kb-legend__gtitle">{group.title}</h3>
          <dl className="kb-legend__list">
            {group.terms.map((term) => (
              <div key={term.id} className="kb-legend__row" data-term={term.id}>
                <dt className="kb-legend__sample">
                  <span aria-hidden="true" className="kb-legend__draw"><Sample term={term} /></span>
                  <span className="kb-visually-hidden">{term.name}</span>
                </dt>
                <dd className="kb-legend__meaning" title={term.meaning}>{term.meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="kb-legend__foot">
        Model, budget and connection settings:{' '}
        <button type="button" className="kb-legend__link" onClick={() => go('wiki')}>Settings → Wiki</button>
        {' '}and{' '}
        <button type="button" className="kb-legend__link" onClick={() => go('models')}>Models</button>.
      </p>
    </Popover>
  );
}
