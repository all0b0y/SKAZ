import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import tokensCss from '../styles/tokens.css?raw';
import { BoardCanvas } from './BoardCanvas';
import { BoardFrame, type BoardSize, type BoardTheme } from './BoardFrame';
import './board.css';

/**
 * Dev-only entry of the design board (`#design-board`). `kb/main.tsx` imports this module only
 * behind `import.meta.env.DEV`, so the production bundle never contains it.
 */

const RAW = import.meta.glob(['../styles/*.css', '../fx/*.css', '../material/*.css', '../../brand/*.css', '!../styles/tokens.css'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const CSS_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, css]) => [path.replace(/^(\.\.\/)+/, ''), css]),
);

export interface BoardRoute { kind: 'canvas' | 'frame'; theme: BoardTheme; size: BoardSize; base: string; accent: string }

export function parseBoardRoute(hash: string): BoardRoute | null {
  if (!hash.startsWith('#design-board')) return null;
  const [path, query = ''] = hash.slice(1).split('?');
  if (path !== 'design-board/frame') return { kind: 'canvas', theme: 'light', size: 'm', base: 'milk', accent: 'ink' };
  const q = new URLSearchParams(query);
  const theme: BoardTheme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const s = q.get('size');
  const size: BoardSize = s === 's' || s === 'l' ? s : 'm';
  const word = (v: string | null, d: string) => (v && /^[a-z]+$/.test(v) ? v : d);
  return { kind: 'frame', theme, size, base: word(q.get('base'), 'milk'), accent: word(q.get('accent'), 'ink') };
}

export function mountBoard(container: HTMLElement): void {
  const route = parseBoardRoute(window.location.hash) ?? { kind: 'canvas', theme: 'light', size: 'm', base: 'milk', accent: 'ink' };
  const html = document.documentElement;
  html.dataset.kbUi = '';
  html.dataset.board = route.kind;
  if (route.kind === 'frame') {
    html.dataset.theme = route.theme;
    html.dataset.textSize = route.size;
    html.dataset.base = route.base;
    html.dataset.accent = route.accent;
  }
  document.title = 'SKAZ · design board';
  createRoot(container).render(
    <StrictMode>
      {route.kind === 'canvas'
        ? <BoardCanvas />
        : <BoardFrame theme={route.theme} size={route.size} tokensCss={tokensCss} cssFiles={CSS_FILES} />}
    </StrictMode>,
  );
}
