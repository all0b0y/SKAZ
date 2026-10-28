import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { ScrollEdges, scrollEdges } from './ScrollEdges';

// Stage 6 B2 (decision 30): GradualBlur — the thread fades under the title bar and above the composer;
// each edge hides at its own scroll end.

describe('scrollEdges: which ends have content behind them', () => {
  it('top only once scrolled, bottom only while there is more below (1 px slack)', () => {
    expect(scrollEdges({ scrollTop: 0, clientHeight: 300, scrollHeight: 1000 })).toEqual({ top: false, bottom: true });
    expect(scrollEdges({ scrollTop: 400, clientHeight: 300, scrollHeight: 1000 })).toEqual({ top: true, bottom: true });
    expect(scrollEdges({ scrollTop: 699.5, clientHeight: 300, scrollHeight: 1000 })).toEqual({ top: true, bottom: false });
    expect(scrollEdges({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 })).toEqual({ top: false, bottom: false });
  });
});

function Thread() {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={ref} data-testid="scroll"><p>text</p></div>
      <ScrollEdges scrollRef={ref} show />
    </div>
  );
}

describe('ScrollEdges', () => {
  it('follows scrolling: each edge switches on and off at its scroll end; never announced', () => {
    const { container } = render(<Thread />);
    const el = screen.getByTestId('scroll');
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    const top = () => container.querySelector('.kb-edge--top')!;
    const bottom = () => container.querySelector('.kb-edge--bottom')!;
    act(() => { el.scrollTop = 0; fireEvent.scroll(el); });
    expect(top()).toHaveAttribute('data-on', 'false');
    expect(bottom()).toHaveAttribute('data-on', 'true');
    act(() => { el.scrollTop = 350; fireEvent.scroll(el); });
    expect(top()).toHaveAttribute('data-on', 'true');
    expect(bottom()).toHaveAttribute('data-on', 'true');
    act(() => { el.scrollTop = 700; fireEvent.scroll(el); });
    expect(top()).toHaveAttribute('data-on', 'true');
    expect(bottom()).toHaveAttribute('data-on', 'false');
    // Decorative: aria-hidden, the four blur layers, nothing to focus or click.
    for (const edge of [top(), bottom()]) {
      expect(edge).toHaveAttribute('aria-hidden', 'true');
      expect(edge.querySelectorAll('.kb-edge__blur')).toHaveLength(4);
      expect(edge.querySelector('button, a, [tabindex]')).toBeNull();
    }
  });
});

describe('GradualBlur in the chat', () => {
  const side = () => screen.getByRole('region', { name: 'Chats' });
  const centre = () => screen.getByRole('region', { name: 'Chat' });

  it('a chat with messages has both edges over its thread, outside the conversation log; the empty view has none', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    await within(side()).findByRole('button', { name: /Why is there a logarithm/ });
    expect(centre().querySelector('.kb-edge')).toBeNull(); // new chat: the dither field, no edges
    await user.click(within(side()).getByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    const log = within(centre()).getByRole('log', { name: 'Conversation' });
    const edges = centre().querySelectorAll('.kb-edge');
    expect(edges).toHaveLength(2);
    // Siblings of the scroller in the chat stage: they stay put while the thread scrolls under them.
    for (const edge of edges) {
      expect(log.contains(edge)).toBe(false);
      expect(edge.parentElement).toBe(log.parentElement);
    }
  });
});
