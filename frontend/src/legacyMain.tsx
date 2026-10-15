// The current interface (sessions, notes, Codex chats). Unchanged; split out of main.tsx so its
// global styles load only when it is the chosen interface.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/app.css';
import './styles/motion.css';

export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
