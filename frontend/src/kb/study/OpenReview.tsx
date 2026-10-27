import { useRef, useState, type ReactNode } from 'react';
import type { KbStudyIdeaReview, KbStudyResponse, KbStudyReview } from '../../api/kb/types.gen';
import { Icon, type IconName } from '../ui';
import { SourceMarks } from '../cite/SourceMarks';

/**
 * P3-a: an open answer's review, variant C «Answer first» (`.dev/ui-blocks/p3/p3-v3.html`).
 * Compact by default — status, «N of M key ideas», what is still missing, Full review; the full
 * report on demand: «Also right in your answer», your answer, how it could look (additions
 * underlined, each with its note), why it matters, the source. Everything here is the agent's
 * opinion, not a fact; the share and the status are SKAZ's own count of the key ideas.
 */

export type ReviewStatus = NonNullable<KbStudyResponse['status']>;

/** Soft words everywhere in tests (P3-a decision 3). */
export const STATUS_WORD: Record<ReviewStatus, string> = { got: 'Got it', almost: 'Almost there', not_yet: 'Not yet' };
const STATUS_ICON: Record<ReviewStatus, IconName> = { got: 'allowed', almost: 'concept', not_yet: 'minus' };
const IDEA_ICON: Record<KbStudyIdeaReview['status'], IconName> = { covered: 'check', partial: 'concept', missing: 'minus' };
/** An answer checked before key ideas (only a verdict word): the same soft status. */
const FROM_VERDICT: Record<string, ReviewStatus> = { right: 'got', partly: 'almost', wrong: 'not_yet' };

export function statusOf(response: KbStudyResponse): ReviewStatus | null {
  return response.status ?? (response.verdict ? FROM_VERDICT[response.verdict] ?? null : null);
}

/** 2½ of 5: covered + ½·partial, counted by SKAZ (an idea «counted by you» is covered). */
export function ideaPoints(ideas: readonly KbStudyIdeaReview[]): number {
  return ideas.reduce((n, i) => n + (i.by_user || i.status === 'covered' ? 1 : i.status === 'partial' ? 0.5 : 0), 0);
}

export const formatPoints = (n: number): string => (Number.isInteger(n) ? String(n) : `${Math.floor(n) || ''}½`);

const ideaShort = (text: string): string => {
  const one = text.replace(/[.。]+$/, '').trim();
  return one.length > 60 ? `${one.slice(0, 59).trimEnd()}…` : one;
};

export function ReviewStatusMark({ status }: { status: ReviewStatus }) {
  return (
    <span className={`kb-st-rv__st kb-st-rv__st--${status}`}>
      <Icon name={STATUS_ICON[status]} size={15} />{STATUS_WORD[status]}
    </span>
  );
}

/** The quiet line under the answer after the check. */
export function OpenCompact({ response, who, open, onToggle }: {
  response: KbStudyResponse; who: string; open: boolean; onToggle: () => void;
}) {
  const status = statusOf(response);
  if (!status) return null;
  const review = response.review;
  const ideas = review?.ideas ?? [];
  const points = ideaPoints(ideas);
  const missing = ideas.filter((i) => !i.by_user && i.status !== 'covered');
  const line = status === 'not_yet'
    ? review?.comment ?? null
    : missing.length ? `Still to add: ${missing.map((i) => ideaShort(i.text)).join('; ')}.` : null;
  return (
    <div className="kb-st-rv" role="status">
      <div className="kb-st-rv__row">
        <ReviewStatusMark status={status} />
        {/* «Not yet» never shows «0 of 5» (p3-v3). */}
        {ideas.length > 0 && points > 0 && <span className="kb-st-rv__muted">· {formatPoints(points)} of {ideas.length} key ideas</span>}
        <span className="kb-st-rv__who" title={`${who} · not a fact`} aria-label={`${who} · not a fact`}><Icon name="agent" size={13} /></span>
        <span className="kb-st-spacer" />
        {review && (
          <button type="button" className="kb-st-rv__link" aria-expanded={open} onClick={onToggle}>
            Full review<Icon name={open ? 'chevronUp' : 'chevronRight'} size={13} />
          </button>
        )}
      </div>
      {line && <p className="kb-st-rv__miss">{line}</p>}
      {!review && (response.missing || response.comment) && (
        // Checked before key ideas existed: what the agent said then.
        <p className="kb-st-rv__miss">{response.missing ? `Still to add: ${response.missing}` : null}{response.comment ? ` ${response.comment}` : null}</p>
      )}
    </div>
  );
}

/** The full report (on demand). `onRecheck` / `onCount`: «I did say this» and «counted by you» (decision 6a). */
export function OpenReport({ review, response, who, source, busy, onRecheck, onCount, footer }: {
  review: KbStudyReview; response: KbStudyResponse; who: string; source: ReactNode; busy: boolean;
  onRecheck: (ideaId: string, words: string) => Promise<boolean>; onCount: (ideaId: string, counted: boolean) => void;
  footer?: ReactNode;
}) {
  const status = statusOf(response)!;
  const points = ideaPoints(review.ideas);
  const notes = review.ideas.filter((i) => i.status !== 'covered' || i.by_user || i.recheck);
  const [hot, setHot] = useState<string | null>(null);
  /** The idea whose «I did say this» is open: the user selects words of their answer for it. */
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const yoursRef = useRef<HTMLParagraphElement | null>(null);
  const added = review.model_answer.some((p) => p.added);

  const recheck = async (ideaId: string) => {
    const selection = window.getSelection();
    const words = selection && yoursRef.current && selection.rangeCount && yoursRef.current.contains(selection.anchorNode)
      ? selection.toString().trim() : '';
    if (!words) { setPickError('Select the words in your answer first.'); return; }
    setPickError(null);
    if (await onRecheck(ideaId, words)) setPicking(null);
  };

  return (
    <div className="kb-st-rv__report" aria-label="Full review">
      <div className="kb-st-rv__row">
        <ReviewStatusMark status={status} />
        {review.ideas.length > 0 && points > 0 && <span className="kb-st-rv__muted">· {formatPoints(points)} of {review.ideas.length} key ideas</span>}
      </div>
      <p className="kb-st-rv__by">{who} · not a fact</p>
      {review.comment && <p className="kb-st-rv__p">{review.comment}</p>}

      {review.also_right.length > 0 && (
        <>
          <h4 className="kb-st-rv__h">Also right in your answer</h4>
          <ul className="kb-st-rv__also">
            {review.also_right.map((a, i) => (
              <li key={i}>
                <Icon name="check" size={13} />
                <span>{a.text}{a.basis === 'source' ? <SourceMarks citations={a.citations} /> : <span className="kb-st-rv__agent"> · agent’s knowledge</span>}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="kb-st-rv__h">Your answer</h4>
      <p ref={yoursRef} className="kb-st-rv__yours" data-picking={picking ? 'true' : undefined}>{response.text}</p>

      {review.model_answer.length > 0 && (
        <>
          <h4 className="kb-st-rv__h">How it could look</h4>
          <p className="kb-st-rv__p">
            {review.model_answer.map((piece, i) => (
              <span key={i}>
                {i > 0 ? ' ' : ''}
                {piece.added
                  ? <span className={`kb-st-rv__add${hot && hot === piece.idea ? ' is-hot' : ''}`} onMouseEnter={() => setHot(piece.idea)}
                    onMouseLeave={() => setHot(null)}>{piece.text}</span>
                  : piece.text}
              </span>
            ))}
          </p>
          {added && (
            <p className="kb-st-rv__hint">
              {points > 0 ? 'Underlined — what would round your answer out.' : 'Underlined — what the answer is built from.'} Point at it to see why.
            </p>
          )}
        </>
      )}

      {notes.length > 0 && (
        <>
          <h4 className="kb-st-rv__h">Why it matters</h4>
          <ol className={`kb-st-rv__notes${hot ? ' is-dim' : ''}`}>
            {notes.map((idea) => (
              <li key={idea.id} className={hot === idea.id ? 'is-hot' : undefined} onMouseEnter={() => setHot(idea.id)} onMouseLeave={() => setHot(null)}>
                <span className={`kb-st-rv__g kb-st-rv__g--${idea.by_user ? 'covered' : idea.status}`}>
                  <Icon name={IDEA_ICON[idea.by_user ? 'covered' : idea.status]} size={13} />
                </span>
                <div>
                  <div className="kb-st-rv__nt">{idea.text}<SourceMarks citations={idea.citations} /></div>
                  {idea.yours && <p className="kb-st-rv__nw">You were close: «{idea.yours}».</p>}
                  {idea.why && (
                    <p className="kb-st-rv__nw">
                      {idea.why}
                      {idea.why_basis === 'source' ? <SourceMarks citations={idea.why_citations} /> : <span className="kb-st-rv__agent"> · agent’s knowledge</span>}
                    </p>
                  )}
                  {idea.recheck?.note && <p className="kb-st-rv__nw kb-st-rv__recheck">{idea.recheck.note}</p>}
                  <div className="kb-st-rv__acts">
                    {idea.by_user ? (
                      <>
                        <span className="kb-st-rv__muted">counted by you</span>
                        <button type="button" className="kb-st-rv__link" disabled={busy} onClick={() => onCount(idea.id, false)}>Undo</button>
                      </>
                    ) : idea.status !== 'covered' && (
                      idea.rechecking ? <span className="kb-st-rv__muted">Rechecking…</span>
                        : picking === idea.id ? (
                          <>
                            <span className="kb-st-rv__muted">Select the words in your answer, then</span>
                            <button type="button" className="kb-st-rv__link" disabled={busy} onClick={() => void recheck(idea.id)}>Recheck</button>
                            <button type="button" className="kb-st-rv__link" onClick={() => { setPicking(null); setPickError(null); }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="kb-st-rv__link" disabled={busy} onClick={() => { setPicking(idea.id); setPickError(null); }}>I did say this</button>
                            {idea.recheck && idea.recheck.status !== 'covered' && (
                              <button type="button" className="kb-st-rv__link" disabled={busy} onClick={() => onCount(idea.id, true)}>Count it</button>
                            )}
                          </>
                        )
                    )}
                  </div>
                  {picking === idea.id && pickError && <p className="kb-inline-error" role="alert">{pickError}</p>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="kb-st-rv__src">{source}</p>
      {footer}
    </div>
  );
}
