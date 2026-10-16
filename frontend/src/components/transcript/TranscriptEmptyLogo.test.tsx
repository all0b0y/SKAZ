import { act, cleanup, render } from '@testing-library/react';
import { SAP } from '../../brand/treeGeometry';
import { useStore } from '../../state/store';
import { resetTreeIntro } from '../brand/treeIntro';
import { TranscriptEmptyLogo } from './TranscriptEmptyLogo';

// jsdom has no Web Animations; a recording stand-in lets the intro run on fake timers.
const animate = vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve(), onfinish: null as (() => void) | null }));
const proto = Element.prototype as unknown as Record<string, unknown>;
const saved = { animate: proto.animate, getAnimations: proto.getAnimations };
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  resetTreeIntro();
  animate.mockClear();
  vi.useFakeTimers();
  Object.assign(proto, { animate, getAnimations: () => [] });
  useStore.setState({ ready: true });
});

afterEach(() => {
  // Unmount while the stand-in still exists: stopping an intro cancels its animations.
  cleanup();
  vi.useRealTimers();
  Object.assign(proto, saved);
  window.matchMedia = originalMatchMedia;
});

const logo = (container: HTMLElement) => container.querySelector('.transcript-logo')!;

describe('TranscriptEmptyLogo', () => {
  it('plays the tree intro once per app run, then shows the wordmark; later ones are still', () => {
    const first = render(<TranscriptEmptyLogo />);
    expect(logo(first.container)).toHaveAttribute('data-intro', 'playing');
    expect(first.container.querySelectorAll('.tree-intro__sap rect')).toHaveLength(SAP.trunk.length + SAP.branches.length);
    expect(animate).toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(logo(first.container)).toHaveAttribute('data-intro', 'done');
    expect(first.container.querySelector('.tree-intro__sap')).toBeNull();
    expect(first.container.querySelector('.transcript-logo__word')).toHaveTextContent('SKAZ');
    first.unmount();

    animate.mockClear();
    const second = render(<TranscriptEmptyLogo />);
    expect(logo(second.container)).not.toHaveAttribute('data-intro');
    expect(second.container.querySelector('.tree-intro__sap')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('waits until the startup screen is done before it plays', () => {
    useStore.setState({ ready: false });
    const view = render(<TranscriptEmptyLogo />);
    expect(logo(view.container)).toHaveAttribute('data-intro', 'pending');
    expect(animate).not.toHaveBeenCalled();

    act(() => { useStore.setState({ ready: true }); });
    expect(logo(view.container)).toHaveAttribute('data-intro', 'playing');
    expect(animate).toHaveBeenCalled();
  });

  it('keeps the tree still under reduced motion', () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('reduce'), media: query, onchange: null, dispatchEvent: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const view = render(<TranscriptEmptyLogo />);
    expect(logo(view.container)).not.toHaveAttribute('data-intro');
    expect(view.container.querySelector('.transcript-logo__word')).toHaveTextContent('SKAZ');
    expect(animate).not.toHaveBeenCalled();
  });
});
