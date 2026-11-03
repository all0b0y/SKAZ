import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KbServicesProvider, type KbServices } from '../state/context';
import { MotionProvider } from '../ui/motion';
import { SelectionHeader, SelectionHeaderProvider } from '../ui/listSelection';
import { boardWorld } from '../test/boardWorlds';
import { boardServices, lookPrefs, markReady, settle, useOnce, useReportHeight, warmUp } from './live';
import { patternById, type BoardPattern, type PatternCell } from './patterns';
import type { BoardLook } from './route';

/** One cell: its own stores, warmed up and prepared before the real component is shown. */
function Cell({ pattern, cell, look, onDone }: { pattern: BoardPattern; cell: PatternCell; look: BoardLook; onDone: (error?: string) => void }) {
  const [live] = useState(() => boardServices(boardWorld(cell.world ?? pattern.world), lookPrefs(look)));
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const failed = useRef<string | undefined>(undefined);

  useOnce(true, async () => {
    await warmUp(live.services);
    await cell.prepare?.(live.services);
    await settle();
  }, (error) => { failed.current = error; setReady(true); });

  useOnce(ready, async () => {
    await settle();
    if (root.current) await cell.act?.(root.current, live.services);
    await settle();
  }, (error) => onDone(error ?? failed.current));

  const width = cell.width ?? pattern.cellWidth;
  const bridged = cell.pane === 'side' && cell.sheet === true;
  const stage = (
    <div ref={root} className={`kb-board__pstage${cell.pane ? ` kb-board__pane kb-board__pane--${cell.pane}` : ''}${bridged ? ' kb-board__pane--bridged' : ''}`}
      style={{ width, height: cell.height }} data-selection-surface={cell.header ? '' : undefined}>
      {ready && <Scope services={live.services}>{cell.header ? (
        <SelectionHeaderProvider>
          <SelectionHeader className="kb-head kb-head--side"><h2 className="kb-side__title">{cell.header}</h2></SelectionHeader>
          {cell.render()}
        </SelectionHeaderProvider>
      ) : cell.render()}</Scope>}
    </div>
  );
  return (
    <figure className="kb-board__pcell" data-board-cell={cell.label}>
      {cell.label && <figcaption className="kb-board__label">{cell.label}</figcaption>}
      {bridged ? (
        // The window around the side list: side ground · gutter · the centre sheet's edge, so the
        // open chat's bridge has a sheet to run into (board-only markup, the list is the real one).
        <div className="kb-board__window">
          {stage}
          <div className="kb-board__sheet" aria-hidden="true" />
        </div>
      ) : stage}
    </figure>
  );
}

function Scope({ services, children }: { services: KbServices; children: ReactNode }) {
  return <KbServicesProvider services={services}>{children}</KbServicesProvider>;
}

/** Layer 3 frame: one product pattern in one theme, text size and look (`#design-board/pattern?id=…`). */
export function PatternFrame({ id, look }: { id: string; look: BoardLook }) {
  const pattern = patternById(id);
  const left = useRef(pattern?.cells.length ?? 0);
  const errors = useRef<string[]>([]);
  useReportHeight(`pattern:${id}:${look.theme}-${look.size}`, Boolean(pattern?.fixedHeight));
  useEffect(() => { if (!pattern) markReady([`Unknown pattern “${id}”`]); }, [pattern, id]);

  if (!pattern) {
    return <main className="kb-board"><p className="kb-board__warn">No pattern “{id}”.</p></main>;
  }
  const cellDone = (error?: string) => {
    if (error) errors.current.push(error);
    left.current -= 1;
    if (left.current === 0) markReady(errors.current);
  };
  return (
    <MotionProvider>
      <main className="kb-board kb-board--pattern" data-board-frame={`pattern-${id}-${look.theme}-${look.size}`}>
        <header className="kb-board__head">
          <h1 className="kb-board__h1">{pattern.title}</h1>
          <span className="kb-board__muted">Layer 3 · {look.theme} · text {look.size} · {look.base} / {look.accent} / {look.density}</span>
        </header>
        <p className="kb-board__note">{pattern.note}</p>
        {pattern.gaps?.map((g) => <p key={g} className="kb-board__tag">Not shown here: {g}</p>)}
        <div className="kb-board__pcells">
          {pattern.cells.map((cell, i) => <Cell key={i} pattern={pattern} cell={cell} look={look} onDone={cellDone} />)}
        </div>
      </main>
    </MotionProvider>
  );
}
