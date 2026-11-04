import { useEffect, useMemo } from 'react';
import { MotionProvider } from '../ui/motion';
import { auditCss } from './audit';
import { installForcedStates } from './forceStates';
import { Foundations } from './Foundations';
import { Primitives } from './Primitives';
import { parseTokenBlocks, tokenGroups } from './tokens';

export type BoardTheme = 'light' | 'dark';
export type BoardSize = 's' | 'm' | 'l';

export interface BoardFrameProps {
  theme: BoardTheme;
  size: BoardSize;
  /** Raw tokens.css (injected: Vite gives `?raw`, tests read the file). */
  tokensCss: string;
  /** Every renderer CSS file except tokens.css, by short name, for the drift audit. */
  cssFiles: Record<string, string>;
}

/** One frame of the design board: layers 1–2 in one theme and text size. Lives in its own iframe. */
export function BoardFrame({ theme, size, tokensCss, cssFiles }: BoardFrameProps) {
  const blocks = useMemo(() => parseTokenBlocks(tokensCss), [tokensCss]);
  const groups = useMemo(() => tokenGroups(blocks.light), [blocks]);
  const audit = useMemo(() => auditCss(cssFiles), [cssFiles]);

  useEffect(() => {
    if (typeof CSSStyleRule === 'undefined') return undefined;
    installForcedStates();
    // Vite injects/updates <style> tags on HMR: rebuild the forced copies when they change.
    const obs = new MutationObserver(() => installForcedStates());
    obs.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    // Tell the canvas how tall this frame is, so the iframe shows it whole.
    if (window.parent === window || typeof ResizeObserver === 'undefined') return undefined;
    const send = () => window.parent.postMessage({ kbBoard: 'height', theme, size, height: document.documentElement.scrollHeight }, window.location.origin);
    const obs = new ResizeObserver(send);
    obs.observe(document.body);
    send();
    return () => obs.disconnect();
  }, [theme, size]);

  return (
    <MotionProvider>
      <main className="kb-board" data-board-frame={`${theme}-${size}`}>
        <header className="kb-board__head">
          <h1 className="kb-board__h1">SKAZ design board</h1>
          <span className="kb-board__muted">Layers 1–2 · {theme} · text {size} · tokens.css of this checkout</span>
        </header>
        <div className="kb-board__layer-title">1 · Foundations</div>
        <Foundations blocks={blocks} groups={groups} audit={audit} theme={theme} size={size} />
        <div className="kb-board__layer-title">2 · Primitives</div>
        <Primitives />
      </main>
    </MotionProvider>
  );
}
