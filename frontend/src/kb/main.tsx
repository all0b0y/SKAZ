import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from './KbApp';
import './styles/index.css';

export function mount(container: HTMLElement): void {
  document.documentElement.dataset.kbUi = '';
  // Full screen hides the traffic lights: CSS drops the title bar's room for them (html[data-full-screen]).
  window.skaz?.onFullScreen?.((on) => document.documentElement.toggleAttribute('data-full-screen', on));
  createRoot(container).render(
    <StrictMode>
      <KbApp />
    </StrictMode>,
  );
}
