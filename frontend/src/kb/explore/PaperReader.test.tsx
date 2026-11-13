import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperReaderState } from '../../api/bridge';
import { PaperReader } from './PaperReader';

const URL_A = 'https://arxiv.org/html/2510.19001';
const URL_B = 'https://example.org/paper-b';
const RECT = { x: 10, y: 20, width: 300, height: 400 };

/** The native paper view as the window's bridge offers it, with a hand to push its state from the main process. */
function nativeView() {
  let listener: ((state: PaperReaderState) => void) | null = null;
  const api = {
    show: vi.fn(async () => true),
    bounds: vi.fn(async () => true),
    hide: vi.fn(async () => true),
    navigate: vi.fn(async () => true),
    onState: vi.fn((next: (state: PaperReaderState) => void) => { listener = next; return () => { listener = null; }; }),
  };
  const emit = (state: Partial<PaperReaderState>) => act(() => {
    listener?.({ url: null, title: '', loading: false, canGoBack: false, canGoForward: false, error: null, ...state });
  });
  return { api, emit, listening: () => listener !== null };
}

/** ResizeObserver is not in jsdom: a fake that lets a test say «the slot changed». */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private readonly callback: () => void) { FakeResizeObserver.all.push(this); }
  fire() { this.callback(); }
}

let box = { ...RECT };
beforeEach(() => {
  box = { ...RECT };
  FakeResizeObserver.all = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => ({}),
  }) as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { skaz?: unknown }).skaz;
});

const withBridge = () => {
  const view = nativeView();
  (window as unknown as { skaz: unknown }).skaz = { paperReader: view.api };
  return view;
};

describe('EX3 paper reader (UX-1a) — the paper\'s own page over the slot', () => {
  it('opens the page over the slot, with the slot\'s place on the screen', async () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    expect(screen.getByTestId('paper-slot')).toBeInTheDocument();
    expect(view.api.show).toHaveBeenCalledTimes(1);
    expect(view.api.show).toHaveBeenCalledWith(URL_A, RECT);
  });

  it('shows the address and says the view is sandboxed and saves nothing', () => {
    withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    expect(screen.getByTitle(URL_A)).toHaveTextContent(URL_A);
    expect(screen.getByText('sandboxed · nothing saved')).toBeInTheDocument();
  });

  it('follows the slot when it changes size or the window is resized', () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    box = { x: 40, y: 60, width: 500, height: 300 };
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0]!.observe).toHaveBeenCalledWith(screen.getByTestId('paper-slot'));
    FakeResizeObserver.all[0]!.fire();
    expect(view.api.bounds).toHaveBeenLastCalledWith({ x: 40, y: 60, width: 500, height: 300 });
    box = { x: 40, y: 60, width: 520, height: 320 };
    fireEvent(window, new Event('resize'));
    expect(view.api.bounds).toHaveBeenLastCalledWith({ x: 40, y: 60, width: 520, height: 320 });
    expect(view.api.show).toHaveBeenCalledTimes(1);       // following the slot never reloads the page
  });

  it('hides the view when it goes away, and stops following the slot', () => {
    const view = withBridge();
    const { unmount } = render(<PaperReader url={URL_A} covered={false} />);
    view.api.hide.mockClear();
    unmount();
    expect(view.api.hide).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.all[0]!.disconnect).toHaveBeenCalled();
    view.api.bounds.mockClear();
    fireEvent(window, new Event('resize'));
    expect(view.api.bounds).not.toHaveBeenCalled();
  });

  it('keeps the view out of sight while something covers the page, and shows it again after', () => {
    const view = withBridge();
    const { rerender } = render(<PaperReader url={URL_A} covered />);
    expect(view.api.show).not.toHaveBeenCalled();
    expect(view.api.hide).toHaveBeenCalled();
    rerender(<PaperReader url={URL_A} covered={false} />);
    expect(view.api.show).toHaveBeenCalledTimes(1);
    expect(view.api.show).toHaveBeenCalledWith(URL_A, RECT);
    view.api.hide.mockClear();
    rerender(<PaperReader url={URL_A} covered />);
    expect(view.api.hide).toHaveBeenCalled();
    expect(view.api.show).toHaveBeenCalledTimes(1);
  });

  it('opens another paper in the same view', () => {
    const view = withBridge();
    const { rerender } = render(<PaperReader url={URL_A} covered={false} />);
    rerender(<PaperReader url={URL_B} covered={false} />);
    expect(view.api.show).toHaveBeenNthCalledWith(1, URL_A, RECT);
    expect(view.api.show).toHaveBeenNthCalledWith(2, URL_B, RECT);
  });

  it('says there is no page to open when the paper has none, and shows nothing', () => {
    const view = withBridge();
    render(<PaperReader url={null} covered={false} />);
    expect(screen.getByText('This paper has no page to open.')).toBeInTheDocument();
    expect(view.api.show).not.toHaveBeenCalled();
    expect(view.api.hide).toHaveBeenCalled();
    expect(screen.queryByTestId('paper-slot')).not.toBeInTheDocument();
  });
});

describe('EX3 paper reader — what the view reports back', () => {
  it('enables Back and Forward as the page allows, and they step through its history', () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();
    view.emit({ url: URL_A, canGoBack: true, canGoForward: false });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();
    fireEvent.click(back);
    expect(view.api.navigate).toHaveBeenLastCalledWith('back');
    view.emit({ url: URL_A, canGoBack: true, canGoForward: true });
    fireEvent.click(forward);
    expect(view.api.navigate).toHaveBeenLastCalledWith('forward');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(view.api.navigate).toHaveBeenLastCalledWith('reload');
  });

  it('shows the address the view is at, not only the one it was asked for', () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    view.emit({ url: 'https://arxiv.org/pdf/2510.19001' });
    expect(screen.getByTitle('https://arxiv.org/pdf/2510.19001')).toBeInTheDocument();
  });

  it('turns the reload icon while the page loads', () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(reload.querySelector('.kb-explore-spin')).toBeNull();
    view.emit({ url: URL_A, loading: true });
    expect(reload.querySelector('.kb-explore-spin')).not.toBeNull();
    view.emit({ url: URL_A, loading: false });
    expect(reload.querySelector('.kb-explore-spin')).toBeNull();
  });

  it('says why a page did not open, in place of the sandbox note', () => {
    const view = withBridge();
    render(<PaperReader url={URL_A} covered={false} />);
    view.emit({ url: URL_A, error: 'The site did not answer' });
    expect(screen.getByRole('alert')).toHaveTextContent("Didn't open: The site did not answer");
    expect(screen.queryByText('sandboxed · nothing saved')).not.toBeInTheDocument();
  });

  it('listens to the view once, and stops when it goes away', () => {
    const view = withBridge();
    const { unmount } = render(<PaperReader url={URL_A} covered={false} />);
    expect(view.api.onState).toHaveBeenCalledTimes(1);
    expect(view.listening()).toBe(true);
    unmount();
    expect(view.listening()).toBe(false);
  });
});

describe('EX3 paper reader — outside the app (a browser preview, tests)', () => {
  it('offers the link instead of a view, and opens nothing by itself', () => {
    render(<PaperReader url={URL_A} covered={false} />);
    expect(screen.getByText('The page opens here in the SKAZ app.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open in browser' });
    expect(link).toHaveAttribute('href', URL_A);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.queryByTestId('paper-slot')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('still says there is no page when the paper has none', () => {
    render(<PaperReader url={null} covered={false} />);
    expect(screen.getByText('This paper has no page to open.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('copes with a window that has the bridge but no paper reader (an older app)', () => {
    (window as unknown as { skaz: unknown }).skaz = {};
    render(<PaperReader url={URL_A} covered={false} />);
    expect(screen.getByRole('link', { name: 'Open in browser' })).toBeInTheDocument();
  });
});
