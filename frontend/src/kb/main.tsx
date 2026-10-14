import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from './KbApp';
import './styles/index.css';

export function mount(container: HTMLElement): void {
  document.documentElement.dataset.kbUi = '';
  createRoot(container).render(
    <StrictMode>
      <KbApp />
    </StrictMode>,
  );
}
