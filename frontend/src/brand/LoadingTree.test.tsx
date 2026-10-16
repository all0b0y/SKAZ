import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALL_DEPTH, LoadingTree, ROOT_PIXELS, VIEW_BOX } from './LoadingTree';
import { CROWN_CIRCLES, ROOT_CELLS } from './treeGeometry';
import { GROVE_CROWNS, rootColour } from './appIcon';

const css = readFileSync(path.join(__dirname, 'LoadingTree.css'), 'utf8');

type Listener = () => void;
function stubReducedMotion(initial: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', (query: string) => (query.includes('prefers-reduced-motion') ? media : { ...media, matches: false }));
  return { set(value: boolean) { media.matches = value; act(() => listeners.forEach((fn) => fn())); } };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

describe('LoadingTree geometry (the icon\'s own tree, variant A)', () => {
  it('draws every root cell in the icon\'s folder colours, plus the grove, the crown and the trunk', () => {
    const { container } = render(<LoadingTree phase="starting" />);
    const pixels = container.querySelectorAll('rect.skaz-loading__px');
    expect(pixels).toHaveLength(ROOT_CELLS.length);
    ROOT_CELLS.forEach((cell, i) => {
      expect(pixels[i]).toHaveAttribute('x', String(cell.x));
      expect(pixels[i]).toHaveClass(`skaz-loading__px--${rootColour(i)}`);
    });
    expect(container.querySelectorAll('.skaz-loading__grove')).toHaveLength(GROVE_CROWNS.length);
    expect(container.querySelectorAll('.skaz-loading__tree circle')).toHaveLength(CROWN_CIRCLES.length);
    expect(container.querySelector('.skaz-loading__tree path')).not.toBeNull();
    // Tree only: no title next to the mark.
    expect(container.querySelector('text')).toBeNull();
    expect(container.textContent).toBe('Starting SKAZ…');
  });

  it('the sap rises from the root tips to the trunk: deeper pixels of one colour flare first', () => {
    for (const colour of ['blue', 'purple', 'olive'] as const) {
      const own = ROOT_PIXELS.filter((p) => p.colour === colour);
      const deepest = own.reduce((a, b) => (b.y > a.y ? b : a));
      const shallowest = own.reduce((a, b) => (b.y < a.y ? b : a));
      expect(deepest.sapDelay, colour).toBeLessThan(shallowest.sapDelay);
    }
    // Each colour's wave starts at its own offset within the 3.6 s loop.
    const starts = (['blue', 'purple', 'olive'] as const).map((c) => Math.min(...ROOT_PIXELS.filter((p) => p.colour === c).map((p) => p.sapDelay)));
    expect(new Set(starts).size).toBe(3);
    expect(Math.max(...ROOT_PIXELS.map((p) => p.sapDelay))).toBeLessThan(3.6);
  });

  it('only the deepest pixels fall on error', () => {
    const deep = ROOT_PIXELS.filter((p) => p.deep);
    expect(deep.length).toBeGreaterThan(5);
    expect(deep.length).toBeLessThan(ROOT_PIXELS.length / 2);
    ROOT_CELLS.forEach((cell, i) => expect(ROOT_PIXELS[i]!.deep).toBe(cell.depth >= FALL_DEPTH));
  });

  it('the whole tree is centred in the frame and the roots end inside it, well above the bottom edge', () => {
    const [x, y, w, h] = VIEW_BOX.split(' ').map(Number) as [number, number, number, number];
    const circles = [...CROWN_CIRCLES, ...GROVE_CROWNS.flatMap((g) => g.circles)];
    const top = Math.min(...circles.map(([, cy, r]) => cy - r));
    const bottom = Math.max(...ROOT_CELLS.map((c) => c.y + c.size));
    const left = Math.min(...circles.map(([cx, , r]) => cx - r), ...ROOT_CELLS.map((c) => c.x));
    const right = Math.max(...circles.map(([cx, , r]) => cx + r), ...ROOT_CELLS.map((c) => c.x + c.size));
    expect(top - y).toBeCloseTo(y + h - bottom, 1);
    expect(left - x).toBeCloseTo(x + w - right, 1);
    expect(y + h - bottom).toBeGreaterThan(h * 0.1);
  });
});

describe('LoadingTree states', () => {
  it('starting: a visually hidden status for screen readers, the mark hidden from them, no message', () => {
    render(<LoadingTree phase="starting"><p>message</p></LoadingTree>);
    const root = screen.getByTestId('loading-tree');
    expect(root).toHaveAttribute('data-phase', 'starting');
    expect(screen.getByRole('status')).toHaveTextContent('Starting SKAZ…');
    expect(screen.getByRole('status')).toHaveClass('skaz-loading__sr');
    expect(root.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('message')).toBeNull();
  });

  it('error: the message (with its buttons) comes under the tree; the status no longer says starting', () => {
    render(<LoadingTree phase="error"><button type="button">Try again</button></LoadingTree>);
    expect(screen.getByTestId('loading-tree')).toHaveAttribute('data-phase', 'error');
    expect(screen.getByRole('button', { name: 'Try again' }).closest('.skaz-loading__message')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('ready: fades out hidden from assistive technology, without stealing pointer events (CSS)', () => {
    render(<LoadingTree phase="ready" />);
    const root = screen.getByTestId('loading-tree');
    expect(root).toHaveAttribute('data-phase', 'ready');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(css).toMatch(/\[data-phase='ready'\]\s*\{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  });

  it('a new attempt starts the animation from its first frame', () => {
    const { rerender } = render(<LoadingTree phase="error" attempt={0} />);
    const before = screen.getByTestId('loading-tree').querySelector('svg');
    rerender(<LoadingTree phase="starting" attempt={1} />);
    const after = screen.getByTestId('loading-tree').querySelector('svg');
    expect(after).not.toBe(before);
    expect(screen.getByRole('status')).toHaveTextContent('Starting SKAZ…');
  });

  it('reduced motion follows the system setting live', () => {
    const media = stubReducedMotion(true);
    render(<LoadingTree phase="starting" />);
    const root = screen.getByTestId('loading-tree');
    expect(root).toHaveAttribute('data-motion', 'reduced');
    media.set(false);
    expect(root).toHaveAttribute('data-motion', 'full');
  });

  it('pauses while the window is hidden, with no script frame loop', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<LoadingTree phase="starting" />);
    const root = screen.getByTestId('loading-tree');
    expect(root).not.toHaveAttribute('data-paused');
    setHidden(true);
    expect(root).toHaveAttribute('data-paused', 'true');
    setHidden(false);
    expect(root).not.toHaveAttribute('data-paused');
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});

describe('LoadingTree styles (mockup loading-tree-v41, variant A)', () => {
  it('colours come from the theme tokens, never hard-coded', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const token of ['--kb-bg', '--kb-text', '--kb-folder-1', '--kb-folder-2', '--kb-folder-3', '--kb-warn']) expect(css).toContain(`var(${token})`);
  });

  it('starting: 3.6 s sap loop on the root pixels and the grove only; the crown and trunk stay still', () => {
    expect(css).toMatch(/\[data-phase='starting'\] \.skaz-loading__px \{ animation: skaz-loading-sap 3\.6s [^}]*var\(--sap\) infinite/);
    expect(css).toMatch(/\[data-phase='starting'\] \.skaz-loading__grove--blue \{ animation: skaz-loading-grove 3\.6s/);
    expect(css).toMatch(/\[data-phase='starting'\] \.skaz-loading__grove--purple \{ animation: skaz-loading-grove 3\.6s/);
    expect(css).not.toMatch(/\.skaz-loading__tree[^{]*\{[^}]*animation/);
  });

  it('error: amber roots, the deep pixels fall, the tree lifts above the message', () => {
    expect(css).toMatch(/\[data-phase='error'\] \.skaz-loading__px \{ fill: var\(--kb-warn\); \}/);
    expect(css).toMatch(/\[data-phase='error'\] \.skaz-loading__px--deep \{ animation: skaz-loading-fall/);
    expect(css).toMatch(/\[data-phase='error'\] \.skaz-loading__mark \{ animation: skaz-loading-lift/);
  });

  it('reduced motion: no movement, one slow opacity pulse, no fall', () => {
    expect(css).toMatch(/\[data-motion='reduced'\] \.skaz-loading__px,\n[^{]*\.skaz-loading__grove \{ animation: none; \}/);
    expect(css).toMatch(/\[data-motion='reduced'\]\[data-phase='starting'\] \.skaz-loading__roots \{ animation: skaz-loading-pulse/);
    const pulse = /@keyframes skaz-loading-pulse \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(pulse).toContain('opacity');
    expect(pulse).not.toContain('transform');
    expect(css).toMatch(/\[data-motion='reduced'\]\[data-phase='error'\] \.skaz-loading__px--deep \{ opacity: 0; \}/);
  });

  it('a hidden window pauses every animation', () => {
    expect(css).toMatch(/\[data-paused='true'\] \* \{ animation-play-state: paused !important; \}/);
  });
});
