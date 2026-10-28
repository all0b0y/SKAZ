import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** A ResizeObserver the test drives: `resize(el)` delivers a resize of `el` to whoever observes it. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) { FakeResizeObserver.all.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  static resize(el: Element) {
    for (const ro of FakeResizeObserver.all) {
      if (ro.targets.has(el)) ro.cb([{ target: el } as ResizeObserverEntry], ro as unknown as ResizeObserver);
    }
  }
}

function Streaming({ more }: { more: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={ref} data-testid="scroll">
        <div data-testid="content"><p>text</p></div>
        {more && <div data-testid="later">later</div>}
      </div>
      <ScrollEdges scrollRef={ref} show />
    </div>
  );
}

describe('FIX2 C-L4: ScrollEdges follows content growth and coalesces streamed mutations', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeResizeObserver.all = []; });

  it('content that grows without a DOM change (an image decoding) turns the bottom edge on: the content wrapper is observed', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { container, rerender } = render(<Streaming more={false} />);
    const el = screen.getByTestId('scroll');
    let height = 300;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
    const bottom = () => container.querySelector('.kb-edge--bottom')!;
    act(() => { fireEvent.scroll(el); });
    expect(bottom()).toHaveAttribute('data-on', 'false');
    height = 900; // the image inside the content wrapper decoded: the wrapper grew, the scroller did not
    act(() => { FakeResizeObserver.resize(screen.getByTestId('content')); });
    expect(bottom()).toHaveAttribute('data-on', 'true');
    // A wrapper that appears later (the first message of a new chat) is observed too.
    rerender(<Streaming more />);
    await act(async () => { await Promise.resolve(); }); // the mutation observer sees the new child
    height = 300;
    act(() => { fireEvent.scroll(el); });
    expect(bottom()).toHaveAttribute('data-on', 'false');
    height = 1200;
    act(() => { FakeResizeObserver.resize(screen.getByTestId('later')); });
    expect(bottom()).toHaveAttribute('data-on', 'true');
  });

  it('a stream of token batches reads the layout once per frame, not once per batch', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<Thread />);
    const el = screen.getByTestId('scroll');
    let reads = 0;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => { reads += 1; return 1000; }, configurable: true });
    const textNode = el.querySelector('p')!.firstChild as Text;
    reads = 0;
    for (let i = 0; i < 5; i++) {
      textNode.data += ` token${i}`; // one streamed batch
      await act(async () => { await Promise.resolve(); }); // the observer delivers it
    }
    expect(reads).toBe(0);
    act(() => { frames.splice(0).forEach((cb) => cb(0)); });
    expect(reads).toBe(1);
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
