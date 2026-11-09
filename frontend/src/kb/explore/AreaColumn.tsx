import { useState } from 'react';
import type {
  KbArea,
  KbAreaMaterials,
  KbExploring,
  KbFinding,
  KbFindings,
  KbFunnelRun,
  KbRepeatCheck,
} from '../../api/kb/types.gen';
import type { ExploreFindingStart, ExploreResumeBody, FindingToWikiBody } from '../api/explore';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import { Icon } from '../ui';
import { FindingPreview } from './FindingPreview';
import {
  FINDING_LABEL_TEXT,
  MATERIAL_KIND_ICON,
  READ_MARK_LABEL,
  STAGE_STEP,
  type FindingHostComponent,
} from './types';

export interface AreaColumnProps {
  scopeName: string;
  isRootScope: boolean;
  scopePages: number;
  sourcesCount: number;
  activeTab: 'materials' | 'new';
  onTabChange: (tab: 'materials' | 'new') => void;
  materials: KbAreaMaterials | null;
  findings: KbFindings | null;
  worthClosing: readonly KbArea[];
  run: KbFunnelRun | null;
  repeatCheck: KbRepeatCheck | null;
  keyHintDismissed: boolean;
  onDismissKeyHint: () => void;
  onResumeRun: (body?: ExploreResumeBody) => void;
  onCancelRun: () => void;
  onStartRepeats: () => void;
  onPauseRepeats: () => void;
  onResumeRepeats: () => void;
  openFinding: KbFinding | null;
  initialExploreMenuOpen?: boolean;
  onOpenFinding: (finding: KbFinding) => void;
  onCloseFinding: () => void;
  onExploreFinding: (findingId: string, body: ExploreFindingStart) => Promise<KbExploring | void>;
  onAddToWiki: (findingId: string, body?: FindingToWikiBody) => Promise<void>;
  onSelectWorthClosing: (area: KbArea) => void;
  FindingComponent?: FindingHostComponent;
  onOpenDocument?: (target: DocTarget) => void;
  onOpenSettings?: (section?: SettingsSection) => void;
}

function formatMaterialSub(m: KbAreaMaterials['materials'][number]): string {
  const parts: string[] = [];
  if (m.repeat_status === 'checked' && (m.repeated_percent ?? 0) > 0) {
    const src = m.repeats_source_titles[0] ?? 'your wiki';
    parts.push(`Repeats ${src} · ~${m.repeated_percent}%`);
  } else if (m.repeat_status === 'not_checked') {
    parts.push('Not checked for repeats');
  }
  if (m.freshness_mark_ids.length > 0) {
    parts.push('may be outdated — a newer version exists');
  }
  if (m.publication.year) {
    parts.push(String(m.publication.year));
  }
  if (m.wiki_pages > 0) {
    parts.push(`${m.wiki_pages} wiki ${m.wiki_pages === 1 ? 'page' : 'pages'}`);
  }
  if (m.read_mark) {
    parts.push(`you: ${READ_MARK_LABEL[m.read_mark]}`);
  }
  return parts.join(' · ');
}

export function AreaColumn({
  scopeName,
  isRootScope,
  scopePages,
  sourcesCount,
  activeTab,
  onTabChange,
  materials,
  findings,
  worthClosing,
  run,
  repeatCheck,
  keyHintDismissed,
  onDismissKeyHint,
  onResumeRun,
  onCancelRun,
  onStartRepeats,
  onPauseRepeats,
  onResumeRepeats,
  openFinding,
  initialExploreMenuOpen = false,
  onOpenFinding,
  onCloseFinding,
  onExploreFinding,
  onAddToWiki,
  onSelectWorthClosing,
  FindingComponent,
  onOpenDocument,
  onOpenSettings,
}: AreaColumnProps) {
  const [showWhy, setShowWhy] = useState(false);

  if (openFinding) {
    const Host = FindingComponent ?? FindingPreview;
    return (
      <aside className="kb-explore-col kb-explore-col--wide" aria-label="Finding details">
        <div className="kb-explore-col__body">
          <Host
            finding={openFinding}
            scopeName={scopeName}
            initialMenuOpen={initialExploreMenuOpen}
            onBack={onCloseFinding}
            onExplore={onExploreFinding}
            onAddToWiki={onAddToWiki}
            onOpenDocument={onOpenDocument}
          />
        </div>
      </aside>
    );
  }

  if (run && (run.state === 'running' || run.state === 'paused')) {
    const currentStep = STAGE_STEP[run.stage] ?? 1;
    const isPaused = run.state === 'paused';
    const stepClass = (step: number) => {
      if (step < currentStep) return 'is-done';
      if (step === currentStep) return isPaused ? 'is-paused' : 'is-now';
      return '';
    };

    return (
      <aside className="kb-explore-col" aria-label="Search progress">
        <div className="kb-explore-col__body">
          <div className="kb-explore-section-title">
            {isPaused ? 'Search paused' : "Finding what's new"}
          </div>
          <div className="kb-explore-cap">
            in {scopeName} · you can leave, Notifications will tell you
          </div>

          <ol className="kb-explore-steps">
            <li className={stepClass(1)}>
              <span className="kb-explore-steps__dot" />
              <span>Collect from OpenAlex, arXiv…</span>
              <span className="kb-explore-steps__count">{run.counters.checked}</span>
            </li>
            <li className={stepClass(2)}>
              <span className="kb-explore-steps__dot" />
              <span>Your rules</span>
              <span className="kb-explore-steps__count">{run.counters.after_rules} left</span>
            </li>
            <li className={stepClass(3)}>
              {stepClass(3) === 'is-now' ? (
                <Icon name="retry" size={14} className="kb-explore-spin" />
              ) : (
                <span className="kb-explore-steps__dot" />
              )}
              <span>Sort by area</span>
              <span className="kb-explore-steps__count">
                {run.counters.decided} of {run.counters.after_rules}
              </span>
            </li>
            <div className="kb-explore-steps__sub">
              {run.decision_provider === 'openrouter_jev'
                ? 'OpenRouter Jev'
                : 'local model · free'}
            </div>
            <li className={stepClass(4)}>
              {stepClass(4) === 'is-now' ? (
                <Icon name="retry" size={14} className="kb-explore-spin" />
              ) : (
                <span className="kb-explore-steps__dot" />
              )}
              <span>Check against your wiki</span>
              <span className="kb-explore-steps__count">
                {run.counters.novelty_checked > 0
                  ? `${run.counters.novelty_checked} of ${run.budget.limit}`
                  : 'top 20–30'}
              </span>
            </li>
            <div className="kb-explore-steps__sub">uses your subscription</div>
            <li className={stepClass(5)}>
              <span className="kb-explore-steps__dot" />
              <span>Ready</span>
              <span className="kb-explore-steps__count" />
            </li>
          </ol>

          {isPaused && (
            <div className="kb-explore-stop-box">
              {run.stop_reason === 'decision_model_required' && (
                <>
                  <div className="kb-explore-stop-box__title">
                    Choose how to sort candidates by area
                  </div>
                  <p className="kb-explore-stop-box__text">
                    Sorting uses a small local model for free, or OpenRouter Jev.
                  </p>
                  <div className="kb-explore-stop-box__actions">
                    {(run.decision_choices.length > 0
                      ? run.decision_choices
                      : (['download_local', 'openrouter_jev'] as const)
                    ).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className="kb-explore-btn kb-explore-btn--primary"
                        onClick={() => onResumeRun({ decision_choice: choice })}
                      >
                        {choice === 'download_local'
                          ? 'Download local model · free'
                          : 'Use OpenRouter Jev'}
                      </button>
                    ))}
                    <button type="button" className="kb-explore-btn" onClick={onCancelRun}>
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {run.stop_reason === 'openalex_daily_limit' && (
                <>
                  <div className="kb-explore-stop-box__title">OpenAlex daily limit reached</div>
                  <p className="kb-explore-stop-box__text">
                    {run.retry_at
                      ? `Retry available at ${run.retry_at}. Your progress is saved.`
                      : 'Your progress is saved and can continue when the daily limit resets.'}
                  </p>
                  <div className="kb-explore-stop-box__actions">
                    <button
                      type="button"
                      className="kb-explore-btn"
                      onClick={() => onOpenSettings?.('search')}
                    >
                      OpenAlex key in Settings
                    </button>
                    <button type="button" className="kb-explore-btn" onClick={onCancelRun}>
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {run.stop_reason === 'science_consent_required' && (
                <>
                  <div className="kb-explore-stop-box__title">
                    Science search needs your permission
                  </div>
                  <p className="kb-explore-stop-box__text">
                    Enable scientific literature search in Settings → Search to query OpenAlex and
                    arXiv.
                  </p>
                  <div className="kb-explore-stop-box__actions">
                    <button
                      type="button"
                      className="kb-explore-btn kb-explore-btn--primary"
                      onClick={() => onOpenSettings?.('search')}
                    >
                      Open Settings
                    </button>
                  </div>
                </>
              )}

              {run.stop_reason === 'budget' && (
                <>
                  <div className="kb-explore-stop-box__title">
                    Checked {run.budget.used} of {run.budget.limit} candidates
                  </div>
                  <div className="kb-explore-stop-box__actions">
                    <button
                      type="button"
                      className="kb-explore-btn kb-explore-btn--primary"
                      onClick={() =>
                        onResumeRun(
                          run.checkpoint
                            ? {
                                checkpoint_id: run.checkpoint.id,
                                revision: run.checkpoint.revision,
                              }
                            : undefined,
                        )
                      }
                    >
                      Continue · next 30
                    </button>
                    <button type="button" className="kb-explore-btn" onClick={onCancelRun}>
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {run.stop_reason !== 'decision_model_required' &&
                run.stop_reason !== 'openalex_daily_limit' &&
                run.stop_reason !== 'science_consent_required' &&
                run.stop_reason !== 'budget' && (
                  <div className="kb-explore-stop-box__actions">
                    <button
                      type="button"
                      className="kb-explore-btn kb-explore-btn--primary"
                      onClick={() =>
                        onResumeRun(
                          run.checkpoint
                            ? {
                                checkpoint_id: run.checkpoint.id,
                                revision: run.checkpoint.revision,
                              }
                            : undefined,
                        )
                      }
                    >
                      Continue
                    </button>
                    <button type="button" className="kb-explore-btn" onClick={onCancelRun}>
                      Cancel
                    </button>
                  </div>
                )}
            </div>
          )}
        </div>
      </aside>
    );
  }

  const groups = findings?.groups ?? [];
  const allFindings = groups.flatMap((g) => g.findings);
  const newCount = allFindings.length;
  const coveredCount = findings?.covered_count ?? run?.counters.covered ?? 0;
  const hintCount = findings?.full_text_key_hint_count ?? 0;

  return (
    <aside className="kb-explore-col" aria-label="Area details">
      <div className="kb-explore-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'materials'}
          className={`kb-explore-tabs__btn${activeTab === 'materials' ? ' is-active' : ''}`}
          onClick={() => onTabChange('materials')}
        >
          <span>Your materials</span>
          <span className="kb-explore-tabs__count">{sourcesCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'new'}
          className={`kb-explore-tabs__btn${activeTab === 'new' ? ' is-active' : ''}`}
          onClick={() => onTabChange('new')}
        >
          <span>New</span>
          <span
            className={`kb-explore-tabs__count${newCount > 0 ? ' kb-explore-tabs__count--acc' : ''}`}
          >
            {newCount}
          </span>
        </button>
      </div>

      <div className="kb-explore-col__body">
        {activeTab === 'materials' ? (
          <>
            <div className="kb-explore-cap">
              {isRootScope
                ? 'Added lately'
                : `${scopePages} wiki pages from ${sourcesCount} sources`}
            </div>

            {repeatCheck &&
            (repeatCheck.state === 'running' || repeatCheck.state === 'paused') ? (
              <div className="kb-explore-repeats-box">
                <div className="kb-explore-repeats-box__title">
                  {repeatCheck.state === 'paused'
                    ? 'Repeat check paused'
                    : 'Checking older materials'}
                </div>
                <div className="kb-explore-repeats-box__meta">
                  {repeatCheck.materials_checked} of{' '}
                  {repeatCheck.materials_checked + repeatCheck.materials_remaining} materials
                  checked
                </div>
                <div className="kb-explore-repeats-box__meta">
                  Budget used: {repeatCheck.budget.used} of {repeatCheck.budget.limit} claim
                  comparisons
                </div>
                <div className="kb-explore-repeats-box__actions">
                  {repeatCheck.state === 'running' ? (
                    <button type="button" className="kb-explore-btn" onClick={onPauseRepeats}>
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="kb-explore-btn kb-explore-btn--primary"
                      onClick={onResumeRepeats}
                    >
                      Continue
                    </button>
                  )}
                </div>
              </div>
            ) : (
              (materials?.not_checked_count ?? 0) > 0 && (
                <div className="kb-explore-repeats-bar">
                  <span className="kb-explore-repeats-bar__text">
                    {materials!.not_checked_count} older materials not checked for repeats
                  </span>
                  <button type="button" className="kb-explore-btn" onClick={onStartRepeats}>
                    Check older materials
                  </button>
                </div>
              )
            )}

            <div className="kb-explore-mat-list">
              {(materials?.materials ?? []).map((mat) => (
                <button
                  key={mat.material_id}
                  type="button"
                  className="kb-explore-mat"
                  onClick={() =>
                    onOpenDocument?.({
                      type: 'material',
                      id: mat.material_id,
                    })
                  }
                >
                  <Icon name={MATERIAL_KIND_ICON[mat.kind] ?? 'pdf'} size={16} />
                  <span className="kb-explore-mat__title">{mat.title}</span>
                  <span className="kb-explore-mat__sub">{formatMaterialSub(mat)}</span>
                </button>
              ))}
            </div>

            <div className="kb-explore-foot">
              <button type="button" className="kb-explore-link">
                Open in Wiki
              </button>
              <button type="button" className="kb-explore-link">
                All {sourcesCount}
              </button>
            </div>
          </>
        ) : (
          <>
            {run?.state === 'done' ? (
              <div className="kb-explore-done">
                <Icon name="check" size={14} />
                <strong>Done just now</strong>
                <span className="kb-explore-muted">
                  {' '}
                  · {newCount} new here · {coveredCount} repeat what you have
                </span>
              </div>
            ) : (
              <div className="kb-explore-cap">
                <span>Checked Mon · {coveredCount} repeat what you have </span>
                <button
                  type="button"
                  className="kb-explore-link"
                  onClick={() => setShowWhy((v) => !v)}
                >
                  Why
                </button>
              </div>
            )}

            {showWhy && (
              <div className="kb-explore-cap">
                Already-covered candidates repeat claims already in your wiki and stay hidden.
              </div>
            )}

            {hintCount > 0 && !keyHintDismissed && (
              <div className="kb-explore-hint-card">
                <span className="kb-explore-hint-card__text">
                  Add a free OpenAlex key to get full text for {hintCount} of these
                </span>
                <div className="kb-explore-hint-card__actions">
                  <button
                    type="button"
                    className="kb-explore-link"
                    onClick={() => onOpenSettings?.('search')}
                  >
                    Add key in Settings
                  </button>
                  <button
                    type="button"
                    className="kb-explore-icon-btn"
                    aria-label="Dismiss OpenAlex key hint"
                    onClick={onDismissKeyHint}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>
            )}

            {groups.length === 0 || newCount === 0 ? (
              <div className="kb-explore-cap">Nothing new since Mon.</div>
            ) : (
              <div className="kb-explore-groups">
                {groups.map((group, gIdx) => (
                  <div
                    key={group.task_id ?? `group-${gIdx}`}
                    className="kb-explore-group"
                  >
                    {group.task_title && (
                      <div className="kb-explore-group__head">
                        <span className="kb-explore-group__title">{group.task_title}</span>
                        {group.task_state && (
                          <span className="kb-explore-group__meta">
                            {group.task_state === 'running' ? 'Running' : 'Completed'}
                          </span>
                        )}
                      </div>
                    )}
                    {group.findings.map((finding) => {
                      const year = finding.work.publication.year;
                      const shortArea =
                        finding.area_path[finding.area_path.length - 1] ?? '';
                      return (
                        <button
                          key={finding.id}
                          type="button"
                          className="kb-explore-item"
                          onClick={() => onOpenFinding(finding)}
                        >
                          <div className="kb-explore-item__top">
                            <span className="kb-explore-item__title">
                              {finding.work.title}
                            </span>
                            <span className="kb-explore-item__action">Explore</span>
                          </div>
                          <div className="kb-explore-item__sub">
                            {finding.label === 'contradicts' ? (
                              <>
                                <span className="kb-explore-signal">
                                  {FINDING_LABEL_TEXT.contradicts}
                                </span>
                                {year ? ` · ${year}` : ''}
                              </>
                            ) : (
                              <>
                                <span>{FINDING_LABEL_TEXT[finding.label]}</span>
                                {year ? ` · ${year}` : ''}
                                {shortArea ? ` · ${shortArea}` : ''}
                              </>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {worthClosing.length > 0 && (
              <div className="kb-explore-closing">
                <div className="kb-explore-section-title">Worth closing</div>
                {worthClosing.map((area) => (
                  <button
                    key={area.id}
                    type="button"
                    className="kb-explore-item"
                    onClick={() => onSelectWorthClosing(area)}
                  >
                    <span className="kb-explore-item__title">{area.name}</span>
                    <span className="kb-explore-item__sub">
                      {area.gap_reason ??
                        (area.pages === 0
                          ? 'no pages yet · Find sources'
                          : `thin · ${area.sources} source${area.newest_source_year ? `, ${area.newest_source_year}` : ''}`)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
