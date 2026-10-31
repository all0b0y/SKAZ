import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import tokensCss from '../styles/tokens.css?raw';
import { BoardCanvas } from './BoardCanvas';
import { BoardFrame } from './BoardFrame';
import { PatternFrame } from './PatternFrame';
import { ScreenFrame } from './ScreenFrame';
import { PATTERNS } from './patterns';
import { applyLook, parseBoardRoute, SCREEN_SIZES, type BoardRoute } from './route';
import { SCREENS } from './screens';
import './board.css';

/**
 * Dev-only entry of the design board (`#design-board`, routes in route.ts). `kb/main.tsx` imports
 * this module only behind `import.meta.env.DEV`, so the production bundle never contains it.
 */

export { parseBoardRoute, type BoardRoute };

const RAW = import.meta.glob(['../styles/*.css', '../fx/*.css', '../material/*.css', '../../brand/*.css', '!../styles/tokens.css'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const CSS_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, css]) => [path.replace(/^(\.\.\/)+/, ''), css]),
);

/** What the screenshot script reads from the canvas: every frame there is to capture. */
export function boardIndex() {
  return {
    patterns: PATTERNS.map((p) => ({ id: p.id, title: p.title, width: p.width, fixedHeight: p.fixedHeight ?? null })),
    screens: SCREENS.map((s) => ({ id: s.id, title: s.title })),
    sizes: SCREEN_SIZES,
  };
}

export function mountBoard(container: HTMLElement): void {
  const route: BoardRoute = parseBoardRoute(window.location.hash) ?? { kind: 'canvas', layer: 1 };
  const html = document.documentElement;
  html.dataset.kbUi = '';
  // A screen is the app itself: none of the board's page rules (html[data-board]) apply to it.
  if (route.kind === 'screen') html.dataset.boardScreen = route.id;
  else html.dataset.board = route.kind;
  if (route.kind === 'pattern') html.dataset.boardPattern = route.id;
  if (route.kind !== 'canvas') applyLook(html, route);
  if (route.kind === 'canvas') Object.assign(window, { __kbBoardIndex: boardIndex() });
  document.title = route.kind === 'screen' ? `SKAZ · screen ${route.id}` : 'SKAZ · design board';
  // Another board address typed into the same tab: start over (the look lives on <html>).
  window.addEventListener('hashchange', () => window.location.reload());
  createRoot(container).render(
    <StrictMode>
      {route.kind === 'canvas' && <BoardCanvas initialLayer={route.layer} />}
      {route.kind === 'frame' && <BoardFrame theme={route.theme} size={route.size} tokensCss={tokensCss} cssFiles={CSS_FILES} />}
      {route.kind === 'pattern' && <PatternFrame id={route.id} look={route} />}
      {route.kind === 'screen' && <ScreenFrame id={route.id} look={route} />}
    </StrictMode>,
  );
}
