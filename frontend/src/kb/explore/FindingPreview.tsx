import { useState } from 'react';
import type { KbExploring } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { FINDING_LABEL_TEXT, type FindingHostProps } from './types';

const EXPLORE_MODES: ReadonlyArray<{
  mode: KbExploring['mode'];
  label: string;
  hint: string;
}> = [
  { mode: 'brief_tour', label: 'Brief tour', hint: '~5 min' },
  { mode: 'deep_dive', label: 'Deep dive', hint: 'section by section' },
  { mode: 'notes', label: 'Notes', hint: 'with quotes' },
];

export function FindingPreview({
  finding,
  scopeName,
  initialMenuOpen = false,
  onBack,
  onExplore,
  onAddToWiki,
  onOpenDocument,
}: FindingHostProps) {
  const [menuOpen, setMenuOpen] = useState(initialMenuOpen);
  const [addToWiki, setAddToWiki] = useState(true);
  const [selectedMode, setSelectedMode] = useState<KbExploring['mode']>('brief_tour');

  const isPaid = finding.work.access.paid;
  const textBadge = isPaid
    ? 'Paid'
    : finding.text_available === 'full_text'
      ? 'Full text'
      : 'Abstract only · full text is PDF or paywalled';

  const metaParts: string[] = [];
  if (finding.work.authors.length > 0) {
    metaParts.push(finding.work.authors.join(', '));
  }
  if (finding.work.publication.year) {
    metaParts.push(String(finding.work.publication.year));
  }
  if (finding.work.venue) {
    metaParts.push(finding.work.venue);
  }
  if (finding.cites_materials.length > 0) {
    metaParts.push(`cites ${finding.cites_materials[0]!.title} (in your wiki)`);
  } else if (finding.shared_source_count > 0) {
    metaParts.push(`shares ${finding.shared_source_count} of your sources`);
  }
  metaParts.push(textBadge);

  const wikiRefs =
    finding.wiki_refs.length > 0
      ? finding.wiki_refs
      : finding.theses.flatMap((t) => t.wiki_refs);

  const handleModeClick = async (mode: KbExploring['mode']) => {
    setSelectedMode(mode);
    await onExplore(finding.id, { mode, add_to_wiki: addToWiki });
    setMenuOpen(false);
  };

  return (
    <div className="kb-explore-finding">
      <button type="button" className="kb-explore-back" onClick={onBack}>
        <Icon name="chevronLeft" size={14} />
        <span>New in {scopeName}</span>
      </button>

      <div className="kb-explore-finding__body">
        <h3 className="kb-explore-finding__title">{finding.work.title}</h3>
        <div className="kb-explore-finding__by">{metaParts.join(' · ')}</div>

        <div className="kb-explore-finding__label">
          {finding.label === 'contradicts' ? (
            <span className="kb-explore-signal">{FINDING_LABEL_TEXT.contradicts}</span>
          ) : (
            <span>What&apos;s new</span>
          )}
        </div>
        <p className="kb-explore-finding__reason">{finding.reason}</p>

        {wikiRefs.length > 0 && (
          <div className="kb-explore-finding__refs">
            {wikiRefs.map((ref) => (
              <button
                key={`${ref.page_id}-${ref.block_id ?? ''}`}
                type="button"
                className="kb-explore-page-chip"
                onClick={() =>
                  onOpenDocument?.({
                    type: 'page',
                    id: ref.page_id,
                    block_id: ref.block_id,
                  })
                }
              >
                {ref.title}
              </button>
            ))}
          </div>
        )}

        {finding.repeat_hint && (
          <div className="kb-explore-finding__hint">{finding.repeat_hint}</div>
        )}

        {isPaid && finding.work.access.recommendation && (
          <div className="kb-explore-finding__paid">
            <p className="kb-explore-finding__reason">{finding.work.access.recommendation}</p>
          </div>
        )}

        {finding.work.abstract && (
          <>
            <div className="kb-explore-finding__label">Abstract</div>
            <p className="kb-explore-finding__abstract">{finding.work.abstract}</p>
          </>
        )}

        <div className="kb-explore-finding__actions">
          <button
            type="button"
            className="kb-explore-btn kb-explore-btn--primary"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span>Explore</span>
            <Icon name="chevronDown" size={14} />
          </button>

          <button
            type="button"
            className="kb-explore-btn"
            onClick={() =>
              void onAddToWiki(finding.id, {
                content: finding.text_available === 'full_text' ? 'full_text' : 'abstract_only',
              })
            }
          >
            <Icon name="wiki" size={14} />
            <span>Add to wiki</span>
          </button>

          {menuOpen && (
            <div className="kb-explore-menu" role="menu" aria-label="Explore modes">
              {EXPLORE_MODES.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  role="menuitem"
                  className={`kb-explore-menu__item${selectedMode === item.mode ? ' is-active' : ''}`}
                  onClick={() => void handleModeClick(item.mode)}
                >
                  <span>{item.label}</span>
                  <span className="kb-explore-menu__hint">{item.hint}</span>
                </button>
              ))}
              <hr className="kb-explore-menu__sep" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={addToWiki}
                className="kb-explore-menu__check"
                onClick={() => setAddToWiki((v) => !v)}
              >
                <span className={`kb-explore-menu__box${addToWiki ? ' is-checked' : ''}`}>
                  {addToWiki && <Icon name="check" size={12} />}
                </span>
                <span>
                  Add to wiki ·{' '}
                  {finding.text_available === 'full_text' ? 'full text' : 'abstract only'}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
