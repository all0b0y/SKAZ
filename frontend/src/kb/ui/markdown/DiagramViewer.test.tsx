import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownView } from './Markdown';

// The full-size diagram viewer (2026-10-21, chat-actions mock «Open full-size viewer»).

const FLOW = 'flowchart LR\n  A[Lecture] --> B[Wiki]\n  B --> C[Exam]';
const fence = (code: string) => `Before.\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\nAfter.`;

// jsdom has no canvas: Pele measures text by its own metrics then (quietly).
beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });

/** jsdom lays nothing out: the viewer's canvas gets a real-looking size. */
function canvasSize(width = 1200, height = 800) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('kb-dviewer__canvas')) return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    return real.call(this);
  });
}

async function drawn() {
  const user = userEvent.setup();
  render(<MarkdownView className="kb-md" pieces={[fence(FLOW)]} />);
  const figure = await screen.findByRole('figure', { name: 'Diagram' });
  await waitFor(() => expect(figure.querySelector('svg.pele')).not.toBeNull());
  return { user, figure };
}

const pct = (dialog: HTMLElement) => Number(within(dialog).getByRole('status', { name: 'Zoom' }).textContent!.replace('%', ''));
const viewerSvg = (dialog: HTMLElement) => dialog.querySelector('.kb-dviewer__canvas svg') as SVGSVGElement;

describe('Diagram: Open full size', () => {
  it('⤢ on the diagram opens it over the window: Diagram · − % + · Fit · 100% · Copy · Close, and a hint', async () => {
    canvasSize();
    const { user, figure } = await drawn();
    await user.click(within(figure).getByRole('button', { name: 'Open full size' }));
    const dialog = await screen.findByRole('dialog', { name: 'Diagram' });
    for (const name of ['Zoom out', 'Zoom in', 'Fit', 'Zoom to 100%', 'Copy Mermaid source', 'Close']) {
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(dialog).toHaveTextContent('⌘ + scroll or pinch to zoom · drag to move · Esc to close');
    // Its own copy of the drawing (ids of its own, so arrows keep their heads), as vectors.
    const svg = viewerSvg(dialog);
    expect(svg).not.toBeNull();
    expect(svg.textContent).toContain('Lecture');
    // Pele's own root style (its colour variables) goes along: without it the boxes turn black.
    const drawnSvg = figure.querySelector('svg.pele')!;
    const vars = (el: Element) => (el.getAttribute('style') ?? '').split(';').map((d) => d.replace(/\s+/g, '')).filter((d) => d.startsWith('--'));
    expect(vars(drawnSvg).length).toBeGreaterThan(0);
    expect(vars(svg)).toEqual(vars(drawnSvg));
    const ids = Array.from(svg.querySelectorAll('[id]')).map((el) => el.id);
    for (const id of ids) expect(figure.querySelector(`[id="${id}"]`)).toBeNull();
  });

  it('a click on the diagram opens it too; Esc closes and the focus goes back to ⤢', async () => {
    canvasSize();
    const { user, figure } = await drawn();
    await user.click(figure.querySelector('.kb-diagram__canvas')!);
    const dialog = await screen.findByRole('dialog', { name: 'Diagram' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Diagram' })).not.toBeInTheDocument());
    expect(within(figure).getByRole('button', { name: 'Open full size' })).toHaveFocus();
    expect(dialog).not.toBeInTheDocument();
  });

  it('+ − 0 and the buttons zoom between 25% and 800%; the SVG is resized, never scaled as a picture', async () => {
    canvasSize();
    const { user, figure } = await drawn();
    await user.click(within(figure).getByRole('button', { name: 'Open full size' }));
    const dialog = await screen.findByRole('dialog', { name: 'Diagram' });
    const fit = pct(dialog);
    const width = () => Number(viewerSvg(dialog).getAttribute('width'));
    const fitWidth = width();
    await user.keyboard('+');
    expect(pct(dialog)).toBeGreaterThan(fit);
    expect(width()).toBeGreaterThan(fitWidth);
    expect(viewerSvg(dialog).style.transform).toBe('');
    await user.click(within(dialog).getByRole('button', { name: 'Zoom to 100%' }));
    expect(pct(dialog)).toBe(100);
    await user.keyboard('-');
    expect(pct(dialog)).toBeLessThan(100);
    await user.keyboard('0');
    expect(pct(dialog)).toBe(fit);
    for (let i = 0; i < 20; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(pct(dialog)).toBe(800);
    for (let i = 0; i < 30; i += 1) await user.keyboard('-');
    expect(pct(dialog)).toBe(25);
    await user.click(within(dialog).getByRole('button', { name: 'Fit' }));
    expect(pct(dialog)).toBe(fit);
  });

  it('⌘+scroll and pinch zoom around the pointer; scroll, arrows and drag move it; double-click: Fit ↔ 100%', async () => {
    canvasSize();
    const { user, figure } = await drawn();
    await user.click(within(figure).getByRole('button', { name: 'Open full size' }));
    const dialog = await screen.findByRole('dialog', { name: 'Diagram' });
    const canvas = dialog.querySelector('.kb-dviewer__canvas') as HTMLElement;
    const at = () => { const host = viewerSvg(dialog).parentElement as HTMLElement; return [parseFloat(host.style.left), parseFloat(host.style.top)] as const; };
    const fit = pct(dialog);
    const [x0, y0] = at();
    // ⌘ + wheel up at the top-left corner: bigger, and the point under the pointer stays put.
    fireEvent.wheel(canvas, { deltaY: -100, metaKey: true, clientX: x0, clientY: y0 });
    expect(pct(dialog)).toBeGreaterThan(fit);
    expect(at()[0]).toBeCloseTo(x0, 5);
    expect(at()[1]).toBeCloseTo(y0, 5);
    // A pinch is a wheel with ctrlKey.
    const before = pct(dialog);
    fireEvent.wheel(canvas, { deltaY: 10, ctrlKey: true, clientX: 600, clientY: 400 });
    expect(pct(dialog)).toBeLessThan(before);
    // The hint goes after the first use.
    expect(dialog).not.toHaveTextContent('drag to move');
    // A plain scroll moves.
    const [x1, y1] = at();
    fireEvent.wheel(canvas, { deltaX: 30, deltaY: 40 });
    expect(at()).toEqual([x1 - 30, y1 - 40]);
    canvas.focus();
    await user.keyboard('{ArrowRight}');
    expect(at()[0]).toBeLessThan(x1 - 30);
    // Drag.
    const [x2, y2] = at();
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 130, pointerId: 1 });
    expect(at()).toEqual([x2 + 60, y2 + 30]);
    // Double-click: Fit, then 100%.
    fireEvent.doubleClick(canvas, { clientX: 600, clientY: 400 });
    expect(pct(dialog)).toBe(fit);
    fireEvent.doubleClick(canvas, { clientX: 600, clientY: 400 });
    expect(pct(dialog)).toBe(100);
  });

  it('Copy copies the Mermaid source', async () => {
    canvasSize();
    const { user, figure } = await drawn();
    await user.click(within(figure).getByRole('button', { name: 'Open full size' }));
    const dialog = await screen.findByRole('dialog', { name: 'Diagram' });
    await user.click(within(dialog).getByRole('button', { name: 'Copy Mermaid source' }));
    expect(await navigator.clipboard.readText()).toBe(FLOW);
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('a diagram that could not be drawn has no ⤢', async () => {
    render(<MarkdownView className="kb-md" pieces={[fence('flowchart LR\n  A --> ')]} />);
    const figure = await screen.findByRole('figure', { name: 'Diagram' });
    await within(figure).findByRole('alert');
    expect(within(figure).queryByRole('button', { name: 'Open full size' })).toBeNull();
  });
});
