import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Button, Icon } from '../ui';
import { SourceMarks } from '../cite/SourceMarks';
import { GRADES, GRADE_LABEL, PRACTICE, studyApi, type KbStudyCard, type KbStudyPart, type StudyGrade } from './api';
import { useServices } from '../state/context';
import type { StudyActions } from './useStudy';

const GROUP_LABEL: Record<KbStudyCard['group'], string> = { new: 'New', learning: 'Learning', known: 'Known', hard: 'Hard' };

/** Slide away left / come in from the right (study-v1 C: 0.22 s out, 0.26 s in); reduced motion keeps the fade. */
const CARD_IN = { opacity: 0, x: 40 };
const CARD_SHOWN = { opacity: 1, x: 0, transition: { duration: 0.26, ease: [0.2, 0.7, 0.2, 1] as const } };
const CARD_OUT = { opacity: 0, x: -40, transition: { duration: 0.22, ease: 'easeIn' as const } };

export function GroupChip({ group }: { group: KbStudyCard['group'] }) {
  return <span className={`kb-st-chip kb-st-chip--${group}`}><i aria-hidden="true" />{GROUP_LABEL[group]}</span>;
}

/**
 * The card stack (variant C): the current card on a visible stack, flipped upward to its answer
 * (from the source, with its quote) and the agent's explanation labelled apart; graded with the
 * interval each grade gives, or skipped. Space flips, ←/→ move, 1–4 grade (with the block focused).
 */
export function CardStack({ part, actions, onError, keys }: {
  part: KbStudyPart; actions: StudyActions; onError: (e: string | null) => void;
  /** The block's key handler slot: keys reach the focused block, not this inner element. */
  keys: { current: ((event: React.KeyboardEvent) => void) | null };
}) {
  const { client } = useServices();
  const total = part.cards.length;
  const done = part.position >= total;
  const card = done ? null : part.cards[part.position] ?? null;
  const back = part.side === 'answer';
  const practice = PRACTICE.has(part.mode);
  const [busy, setBusy] = useState(false);

  const act = async (call: () => Promise<KbStudyPart>) => {
    if (busy) return;
    setBusy(true);
    onError(null);
    const res = await actions.run(call);
    setBusy(false);
    if (!res.ok) onError(res.error);
  };
  const flip = () => {
    if (!card) return;
    const side = back ? 'question' : 'answer';
    actions.optimistic({ ...part, side });
    void act(() => studyApi.move(client, part.id, { side }));
  };
  const go = (delta: number) => {
    const position = Math.max(0, Math.min(total, part.position + delta));
    if (position === part.position) return;
    actions.optimistic({ ...part, position, side: 'question' });
    void act(() => studyApi.move(client, part.id, { position }));
  };
  const grade = (g: StudyGrade) => {
    if (!card || !back) return;
    void act(() => studyApi.grade(client, part.id, card.id, g));
  };
  const hide = () => {
    if (!card) return;
    void act(async () => {
      await studyApi.mark(client, part.id, [card.id], 'hide');
      return studyApi.move(client, part.id, { position: part.position + 1 });
    });
  };

  // Keys act on the focused block only (the composer and other fields keep theirs).
  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); flip(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    else if (back && /^[1-4]$/.test(event.key)) { event.preventDefault(); grade(GRADES[Number(event.key) - 1]!); }
  };

  keys.current = onKey;

  if (total === 0) {
    return (
      <div className="kb-st-stage">
        <p className="kb-st-empty">
          {part.held_back > 0
            ? `Nothing to review now: ${part.held_back} new ${part.held_back === 1 ? 'card waits' : 'cards wait'} for another day (today’s limit for their folder).`
            : 'Nothing to review in this mode now.'}
        </p>
      </div>
    );
  }

  return (
    <div className="kb-st-stage">
      {practice && (
        <p className="kb-st-note">Practice: doesn’t change your schedule — only <b>Again</b> brings a card back sooner.</p>
      )}
      {done ? (
        <DoneCards part={part} onAgain={() => go(-total)} />
      ) : (
        <>
          <div className="kb-st-scene">
            <AnimatePresence mode="popLayout" initial={false}>
              <m.div key={card!.id} className="kb-st-slot" initial={CARD_IN} animate={CARD_SHOWN} exit={CARD_OUT}>
                <CardFaces card={card!} back={back} onFlip={flip} onHide={hide} busy={busy} />
              </m.div>
            </AnimatePresence>
          </div>
          <div className="kb-st-nav">
            <button type="button" className="kb-st-ib" aria-label="Previous card (←)" disabled={part.position === 0 || busy} onClick={() => go(-1)}>
              <Icon name="chevronLeft" size={16} />
            </button>
            {back ? (
              <div className="kb-st-grades" role="group" aria-label="How well did you know it?">
                {GRADES.map((g, i) => {
                  const interval = card!.intervals[g];
                  return (
                    <button key={g} type="button" className={`kb-st-g kb-st-g--${g}`} disabled={busy} aria-keyshortcuts={String(i + 1)}
                      aria-label={`${GRADE_LABEL[g]}${interval ? `, next in ${interval}` : ', schedule unchanged'}`} onClick={() => grade(g)}>
                      {GRADE_LABEL[g]}<small aria-hidden="true">{interval ?? '—'}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <button type="button" className="kb-st-flip" onClick={flip} aria-keyshortcuts="Space">
                <Icon name="flip" size={15} />Show answer <span className="kb-kbd" aria-hidden="true">Space</span>
              </button>
            )}
            <button type="button" className="kb-st-ib" aria-label="Next card (→)" disabled={busy} onClick={() => go(1)}>
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CardFaces({ card, back, onFlip, onHide, busy }: {
  card: KbStudyCard; back: boolean; onFlip: () => void; onHide: () => void; busy: boolean;
}) {
  // The flip is CSS (rotateX 0.42 s; reduced motion: a 0.16 s cross-fade). Keep the faces in the DOM
  // so the turn is visible; the hidden face is out of the accessibility tree.
  const [turned, setTurned] = useState(back);
  useEffect(() => setTurned(back), [back]);
  return (
    <div className={`kb-st-card${turned ? ' is-back' : ''}`} onClick={(e) => {
      if ((e.target as HTMLElement).closest('button, a, .kb-cns, [role="dialog"]')) return;
      onFlip();
    }}>
      <section className="kb-st-face kb-st-face--front" aria-hidden={turned} aria-label="Question">
        <div className="kb-st-kind">
          <GroupChip group={card.group} />
          <button type="button" className="kb-st-know" disabled={busy} tabIndex={turned ? -1 : 0}
            title="Hide this card from reviews" onClick={onHide}>
            <Icon name="hidden" size={14} />I know this
          </button>
        </div>
        <p className="kb-st-q">{card.question}</p>
        <p className="kb-st-hint">Click or <span className="kb-kbd">Space</span> to show the answer</p>
      </section>
      <section className="kb-st-face kb-st-face--back" aria-hidden={!turned} aria-label="Answer">
        <div className="kb-st-kind">Answer · from source</div>
        <p className="kb-st-ans">{card.answer}<SourceMarks citations={card.citations} /></p>
        {card.explanation && (
          <p className="kb-st-ex"><Icon name="analysis" size={14} /><span><b>Agent explanation</b> · {card.explanation}</span></p>
        )}
      </section>
    </div>
  );
}

function DoneCards({ part, onAgain }: { part: KbStudyPart; onAgain: () => void }) {
  const graded = part.cards.filter((c) => c.graded !== null).length;
  const again = part.cards.filter((c) => c.graded === 'again').length;
  return (
    <div className="kb-st-done" role="status">
      <Icon name="allowed" size={18} />
      <div>
        <p className="kb-st-done__title">All {part.cards.length} {part.cards.length === 1 ? 'card' : 'cards'} seen</p>
        <p className="kb-st-done__meta">
          {graded} graded{again ? ` · ${again} to see again soon` : ''}
          {part.held_back > 0 ? ` · ${part.held_back} new ${part.held_back === 1 ? 'card waits' : 'cards wait'} for another day` : ''}
        </p>
      </div>
      <Button size="sm" icon="flip" onClick={onAgain}>Go through again</Button>
    </div>
  );
}
