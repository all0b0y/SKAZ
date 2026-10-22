import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from './KbApp';
import { StudyWindowApp } from './study/StudyWindowApp';
import './styles/index.css';

export function mount(container: HTMLElement): void {
  document.documentElement.dataset.kbUi = '';
  // Full screen hides the traffic lights: CSS drops the title bar's room for them (html[data-full-screen]).
  window.skaz?.onFullScreen?.((on) => document.documentElement.toggleAttribute('data-full-screen', on));
  // A deck or test block's own window (0.3.1 S) loads the same page with the block in its URL fragment.
  const study = window.skaz?.studyWindow ?? null;
  createRoot(container).render(
    <StrictMode>
      {study ? <StudyWindowApp target={study} bridge={window.skaz} /> : <KbApp />}
    </StrictMode>,
  );
}
