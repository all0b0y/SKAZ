import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MotionProvider } from '../ui/motion';
import { StepArt } from './StepArt';

// prefers-reduced-motion: reduce — set before Motion first reads it (this file only).
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

describe('First-launch art with reduced motion', () => {
  it('every step is a still frame: nothing starts hidden, nothing is undrawn', async () => {
    for (const step of ['lang', 'agent', 'speech', 'library', 'summary'] as const) {
      const { container, unmount } = render(
        <MotionProvider><StepArt step={step} tones={['ok', 'warn', 'ok']} /></MotionProvider>,
      );
      const art = container.querySelector('[data-art]')!;
      expect(art.getAttribute('data-still'), step).toBe('true');
      await new Promise((r) => setTimeout(r, 30));
      for (const el of Array.from(art.querySelectorAll<SVGElement>('*'))) {
        const style = el.getAttribute('style') ?? '';
        // First text of each bubble stays visible; the alternative text is the only thing at 0.
        if (/opacity:\s*0(?![.\d])/.test(style)) {
          expect(el.tagName.toLowerCase(), `${step}: hidden element`).toBe('text');
          expect(['Hello', 'Hola']).toContain(el.textContent);
        }
        expect(style, `${step}: scaled to nothing`).not.toMatch(/scale\(0\)|scaleX\(0\)/);
      }
      unmount();
    }
  });
});
