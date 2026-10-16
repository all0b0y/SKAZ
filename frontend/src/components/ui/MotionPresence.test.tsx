import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { MotionPresence } from './MotionPresence';
import { useModalFocus } from '../../hooks/useModalFocus';

function DraftDialog() {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  useModalFocus(ref);
  return <div ref={ref} role="dialog" aria-label="Draft">
    <input aria-label="Draft text" value={value} onChange={e => setValue(e.target.value)} />
  </div>;
}
const scene = (open: boolean) => <><button>Workspace</button>
  <MotionPresence open={open}><DraftDialog /></MotionPresence></>;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('removes a closing dialog from focus and accessibility immediately, before its visual exit finishes', () => {
  vi.useFakeTimers();
  const { rerender, container } = render(scene(true));
  expect(screen.getByRole('textbox')).toHaveFocus();
  rerender(scene(false));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(container.querySelector('[inert]')).not.toBeNull();
  screen.getByRole('button', { name: 'Workspace' }).focus();
  expect(screen.getByRole('button', { name: 'Workspace' })).toHaveFocus();
  act(() => vi.advanceTimersByTime(140));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('cancels dismissal on a rapid reopen and retains the entered draft', () => {
  vi.useFakeTimers();
  const { rerender } = render(scene(true));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Keep my choice' } });
  rerender(scene(false));
  act(() => vi.advanceTimersByTime(60));
  rerender(scene(true));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveValue('Keep my choice');
  expect(input).toHaveFocus();
});

it('does not retain a visual exit when the system requests reduced motion', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const { rerender, container } = render(scene(true));
  rerender(scene(false));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
