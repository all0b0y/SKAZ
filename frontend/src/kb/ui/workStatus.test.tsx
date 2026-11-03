import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './Status';
import { Button } from './Button';

afterEach(() => { delete document.documentElement.dataset.motion; vi.restoreAllMocks(); });

it('real waits and busy buttons use stippling, keeping status words and action semantics', () => {
  render(<><Spinner label="Checking the agent" /><Button busy>Install</Button></>);
  expect(screen.getByRole('status')).toHaveTextContent('Checking the agent');
  expect(screen.getByRole('status').querySelector('[data-stipple-ring] canvas')).not.toBeNull();
  const button = screen.getByRole('button', { name: 'Install' });
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button.querySelector('[data-stipple-ring] canvas')).not.toBeNull();
});

it('motion off retains a still indicator without a frame loop', () => {
  document.documentElement.dataset.motion = 'off';
  const raf = vi.spyOn(window, 'requestAnimationFrame');
  const { container } = render(<Spinner label="Checking the agent" />);
  expect(container.querySelector('[data-stipple-ring] canvas')).not.toBeNull();
  expect(raf).not.toHaveBeenCalled();
});
