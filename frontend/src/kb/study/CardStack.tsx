import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useReducedMotion } from 'motion/react';
import { Icon } from '../ui';
import { SourceMarks } from '../cite/SourceMarks';
import { PRACTICE, studyApi, type KbStudyCard, type KbStudyPart } from './api';
import { useServices } from '../state/context';
import type { StudyActions } from './useStudy';
import { UnclearMark } from './Unclear';

const GROUP_LABEL: Record<KbStudyCard['group'], string> = { new: 'New', learning: 'Learning', known: 'Known', hard: 'Hard' };

export function GroupChip({ group }: { group: KbStudyCard['group'] }) {
  return <span className={`kb-st-chip kb-st-chip--${group}`}><i aria-hidden="true" />{GROUP_LABEL[group]}</span>;
}

/** Up to four edges show below the top card (p3d-v2 «Deck»); the fifth waits out of sight. */
const DEPTH = 4;
/** A card dragged further than this goes back under the pile (a skip). */
const THROW_PX = 120;
const pose = (d: number) => `translateY(${d * 13}px) scale(${1 - d * 0.035})`;

type Pile = NonNullable<KbStudyPart['pile']>;
type PassAction = 'know' | 'skip' | 'back' | 'restart';

/** The pass as the block has it: the backend's, or (a block from before P3-d) the cards from its position on. */
export function pileOf(part: KbStudyPart): Pile {
  return part.pile ?? { queue: part.cards.slice(part.position).map((c) => c.id), known: 0, again: 0, can_back: false };
}

/** What the pass looks like right after `action` (the request's answer confirms it). */
function next(pile: Pile, action: PassAction, cardId: string | null, all: string[]): Pile {
  if (action === 'restart') return { queue: all, known: 0, again: 0, can_back: false };
  if (action === 'back') return pile; // the backend knows which card was skipped last
  const rest = pile.queue.filter((id) => id !== cardId);
  if (action === 'know') return { ...pile, queue: rest, known: pile.known + 1 };
  return { ...pile, queue: [...rest, cardId!], can_back: true };
}

/**
 * The card pile (P3-d, p3d-v2: Deck · Riffle in · Accent ink; decisions 13–15). The top card flips
 * (click or Space); «I know this» (K / Enter) = Good and it leaves the pile; → or dragging it away =
 * Again, once per pass, and it riffles back in under the pile to come back this pass; ← brings back
 * the last one skipped. «N left» counts the pile; the pass ends when it is empty. Practice modes still
 * write only Again (the backend). Reduced motion: nothing flies, the pile changes at once.
 */
export function CardStack({ part, actions, onError, keys }: {
  part: KbStudyPart; actions: StudyActions; onError: (e: string | null) => void;
  /** The block's key handler slot: keys reach the focused block, not this inner element. */
  keys: { current: ((event: React.KeyboardEvent) => void) | null };
}) {
  const { client } = useServices();
  const reduced = useReducedMotion() ?? false;
  const pile = pileOf(part);
  const byId = new Map(part.cards.map((c) => [c.id, c]));
  const queue = pile.queue.filter((id) => byId.has(id));
  const top = queue[0] ? byId.get(queue[0])! : null;
  const back = part.side === 'answer';
  const [busy, setBusy] = useState(false);
  /** The card that just left the pile («I know this»): drawn until its drop ends. */
  const [leaving, setLeaving] = useState<KbStudyCard | null>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  /** A motion to play once the pile has its new order (skip: that card; back: the new top). */
  const pending = useRef<{ id: string | null; kind: 'skip' | 'back'; from: string; dir: number } | null>(null);

  const act = async (call: () => Promise<KbStudyPart>) => {
    if (busy) return false;
    setBusy(true);
    onError(null);
    const res = await actions.run(call);
    setBusy(false);
    if (!res.ok) onError(res.error);
    return res.ok;
  };
  const step = (action: PassAction, cardId: string | null) => {
    if (busy) return;
    actions.optimistic({ ...part, side: 'question', pile: next(pile, action, cardId, part.cards.map((c) => c.id)) });
    void act(() => studyApi.pass(client, part.id, action, cardId));
  };
  const flip = () => {
    if (!top || busy) return;
    const side = back ? 'question' : 'answer';
    actions.optimistic({ ...part, side });
    void act(() => studyApi.move(client, part.id, { side }));
  };
  const skip = (from = 'none', dir = 1) => {
    if (!top || busy) return;
    pending.current = { id: top.id, kind: 'skip', from, dir };
    step('skip', top.id);
  };
  const know = () => {
    if (!top || busy) return;
    setLeaving(top);
    step('know', top.id);
  };
  const bringBack = () => {
    if (!pile.can_back || busy) return;
    pending.current = { id: null, kind: 'back', from: 'none', dir: -1 };
    void act(() => studyApi.pass(client, part.id, 'back', null));
  };

  // Riffle in (skip) / back on top (←), once the pile has its new order. Reduced motion and jsdom: none.
  useLayoutEffect(() => {
    const motion = pending.current;
    if (!motion) return;
    const id = motion.kind === 'back' ? queue[0] ?? null : motion.id;
    if (motion.kind === 'back' && (busy || !id)) return; // wait for the answer that says which card
    pending.current = null;
    const el = id ? els.current.get(id) : undefined;
    if (!el || reduced || typeof el.animate !== 'function') return;
    if (motion.kind === 'skip') {
      const end = pose(Math.min(queue.indexOf(id!), DEPTH - 1));
      const dir = motion.dir;
      el.animate([
        { transform: motion.from === 'none' ? pose(0) : motion.from, zIndex: 70 },
        { transform: `translate(${dir * 330}px, 40px) rotate(${dir * 10}deg) scale(.94)`, zIndex: 70, offset: 0.4 },
        { transform: `translate(${dir * 30}px, 150px) rotate(${dir * 2}deg) scale(.9)`, zIndex: 1, offset: 0.7 },
        { transform: end, zIndex: 1 },
      ], { duration: 760, easing: 'cubic-bezier(.3,.7,.2,1)' });
      // The pile fans out for a moment as the card is shuffled in at the bottom.
      queue.slice(0, DEPTH).forEach((other, d) => {
        const pe = els.current.get(other);
        if (!pe || pe === el) return;
        const r = (d % 2 ? -1 : 1) * (3 + d * 1.5);
        pe.animate([{ transform: pose(d) }, { transform: `${pose(d)} rotate(${r}deg) translateX(${r * 2}px)` }, { transform: pose(d) }],
          { duration: 380, delay: 300, easing: 'ease-in-out' });
      });
    } else {
      el.animate([
        { transform: pose(DEPTH - 1), zIndex: 1 },
        { transform: 'translate(-430px, 10px) rotate(-12deg)', zIndex: 60, offset: 0.45 },
        { transform: pose(0), zIndex: 60 },
      ], { duration: 640, easing: 'cubic-bezier(.3,.7,.25,1)' });
    }
  });

  // Keys act on the focused block only (the composer and other fields keep theirs).
  keys.current = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target.closest('button') && (event.key === ' ' || event.key === 'Enter')) return; // the button's own
    if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); flip(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); skip(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); bringBack(); }
    else if (event.key === 'k' || event.key === 'K' || event.key === 'Enter') { event.preventDefault(); know(); }
  };

  // Dragging the top card: a press without moving flips it; far enough sideways, it goes under the pile.
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; el: HTMLDivElement } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || (e.target as HTMLElement).closest('button, a, .kb-cns, [role="dialog"]')) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, el: e.currentTarget };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add('is-drag');
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    if (!reduced) d.el.style.transform = `translate(${d.dx}px, ${d.dy * 0.35}px) rotate(${d.dx * 0.05}deg)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    d.el.classList.remove('is-drag');
    const from = d.el.style.transform || 'none';
    d.el.style.transform = pose(0);
    if (Math.abs(d.dx) < 6 && Math.abs(d.dy) < 6) { flip(); return; }
    if (Math.abs(d.dx) > THROW_PX) skip(from, Math.sign(d.dx));
  };

  if (part.cards.length === 0) {
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
      {PRACTICE.has(part.mode) && (
        <p className="kb-st-note">Practice: doesn’t change your schedule — only a skipped card comes back sooner.</p>
      )}
      <div className="kb-st-deck">
        {!top && <DonePile part={part} pile={pile} onAgain={() => step('restart', null)} busy={busy} />}
        {queue.slice(0, DEPTH + 1).map((id, d) => {
          const card = byId.get(id)!;
          const isTop = d === 0;
          return (
            <div key={id} ref={(el) => { if (el) els.current.set(id, el); else els.current.delete(id); }}
              className={`kb-st-pc${isTop ? ' is-top' : ''}${isTop && back ? ' is-back' : ''}`}
              style={{ transform: pose(Math.min(d, DEPTH)), zIndex: 50 - d, opacity: d >= DEPTH ? 0 : 1 }}
              aria-hidden={!isTop || undefined}
              {...(isTop ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } : {})}>
              <CardFaces card={card} back={isTop && back} live={isTop} busy={busy}
                onUnclear={() => void act(() => studyApi.mark(client, part.id, [card.id], card.unclear ? 'clear' : 'unclear'))} />
            </div>
          );
        })}
        {leaving && <LeavingCard card={leaving} reduced={reduced} onDone={() => setLeaving(null)} />}
      </div>
      {top && (
        <>
          <div className="kb-st-pnav">
            <button type="button" className="kb-st-ib" aria-label="Bring back the last card (←)" title="Bring back the last card (←)"
              aria-keyshortcuts="ArrowLeft" disabled={!pile.can_back || busy} onClick={bringBack}>
              <Icon name="undo" size={16} />
            </button>
            <span className="kb-st-spacer" />
            {/* Decision 15: no «Not yet» words — an arrow with its tooltip. */}
            <button type="button" className="kb-st-ib" aria-label="Skip — back to the pile (→)" title="Skip — back to the pile (→)"
              aria-keyshortcuts="ArrowRight" disabled={busy} onClick={() => skip()}>
              <Icon name="chevronRight" size={16} />
            </button>
            <button type="button" className="kb-st-knowit" aria-keyshortcuts="K Enter" disabled={busy} onClick={know}>
              <Icon name="check" size={14} />I know this <span className="kb-kbd" aria-hidden="true">K</span>
            </button>
          </div>
          <p className="kb-st-tip">
            {back ? 'Drag the card away or press → to come back to it later'
              : <>Click or <b>Space</b> to flip · drag the card away to come back to it later</>}
          </p>
        </>
      )}
    </div>
  );
}

function CardFaces({ card, back, live, busy, onUnclear }: {
  card: KbStudyCard; back: boolean; live: boolean; busy: boolean; onUnclear: () => void;
}) {
  // The flip is CSS (rotateX 0.42 s; reduced motion: a 0.16 s cross-fade). Keep the faces in the DOM
  // so the turn is visible; the hidden face is out of the accessibility tree.
  const [turned, setTurned] = useState(back);
  useEffect(() => setTurned(back), [back]);
  return (
    <div className="kb-st-pc__in">
      <section className="kb-st-pf kb-st-pf--front" aria-hidden={turned || !live} aria-label={live ? 'Question' : undefined}>
        <div className="kb-st-pf__top">
          <UnclearMark on={!!card.unclear} what="card" disabled={busy} onToggle={onUnclear} tabIndex={live && !turned ? 0 : -1} />
        </div>
        <p className="kb-st-pf__q">{card.question}</p>
      </section>
      <section className="kb-st-pf kb-st-pf--back" aria-hidden={!turned || !live} aria-label={live ? 'Answer' : undefined}>
        <div className="kb-st-pf__top">
          <span className="kb-st-pf__lab">Answer</span>
          <UnclearMark on={!!card.unclear} what="card" disabled={busy} onToggle={onUnclear} tabIndex={live && turned ? 0 : -1} />
        </div>
        <p className="kb-st-pf__ans">{card.answer}<SourceMarks citations={card.citations} /></p>
        {card.explanation && (
          <p className="kb-st-pf__ex"><Icon name="analysis" size={14} /><span><b>Agent explanation</b> · {card.explanation}</span></p>
        )}
      </section>
    </div>
  );
}

/** «I know this»: the card lifts with a stamp and drops out of sight. Reduced motion and jsdom: at once. */
function LeavingCard({ card, reduced, onDone }: { card: KbStudyCard; reduced: boolean; onDone: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stamp = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced || typeof el.animate !== 'function') { onDone(); return undefined; }
    stamp.current?.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1.08)', offset: 0.6 }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }],
    { duration: 260, fill: 'forwards', easing: 'ease-out' });
    const run = el.animate([
      { transform: pose(0), opacity: 1 },
      { transform: 'translateY(-26px) scale(1.03)', opacity: 1, offset: 0.33 },
      { transform: 'translateY(520px) rotate(7deg) scale(.96)', opacity: 0 },
    ], { duration: 780, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    run.onfinish = onDone;
    return () => { run.onfinish = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="kb-st-pc is-top is-leaving" style={{ zIndex: 70 }} aria-hidden="true">
      <div className="kb-st-pc__in">
        <section className="kb-st-pf kb-st-pf--front"><p className="kb-st-pf__q">{card.question}</p></section>
      </div>
      <span ref={stamp} className="kb-st-stamp"><Icon name="check" size={18} />Got it</span>
    </div>
  );
}

function DonePile({ part, pile, onAgain, busy }: { part: KbStudyPart; pile: Pile; onAgain: () => void; busy: boolean }) {
  const later = Math.max(0, part.cards.length - pile.known);
  return (
    <div className="kb-st-pdone" role="status">
      <b>All done</b>
      <span>
        {pile.known} known · {later} come back by the schedule
        {part.held_back > 0 ? ` · ${part.held_back} new ${part.held_back === 1 ? 'card waits' : 'cards wait'} for another day` : ''}
      </span>
      <button type="button" className="kb-st-knowit kb-st-knowit--quiet" disabled={busy} onClick={onAgain}>
        <Icon name="flip" size={14} />Go through again
      </button>
    </div>
  );
}
