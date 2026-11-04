import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from './KbApp';
import './styles/index.css';

export function mount(container: HTMLElement): void {
  document.documentElement.dataset.kbUi = '';
  // Dev-only design board (.dev/docs/DESIGN-SYSTEM.md). DEV is a build-time constant: production
  // builds drop this branch and the board's chunk entirely.
  if (import.meta.env.DEV && window.location.hash.startsWith('#design-board')) {
    void import('./board/mountBoard').then((board) => board.mountBoard(container));
    return;
  }
  // Full screen hides the traffic lights: CSS drops the title bar's room for them (html[data-full-screen]).
  window.skaz?.onFullScreen?.((on) => document.documentElement.toggleAttribute('data-full-screen', on));
  createRoot(container).render(
    <StrictMode>
      <KbApp />
    </StrictMode>,
  );
}
