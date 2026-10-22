import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type MutableRefObject } from 'react';
import { copyToClipboard } from '../../../lib/clipboard';
import { Button, IconButton } from '../Button';
import { Modal } from '../Modal';

/**
 * A diagram at full size over the window (2026-10-21, chat-actions mock «Open full-size viewer»).
 * ⌘+wheel and a trackpad pinch (a wheel event with ctrlKey) zoom around the pointer; a plain wheel,
 * a drag and the arrow keys move it; + − 0 and the bar zoom; a double-click goes Fit ↔ 100%. The
 * SVG itself is resized (width/height over its viewBox), so it stays sharp at any zoom. Nothing is
 * animated: a zoom step lands at once (reduced motion has nothing to turn off).
 */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
const STEP = 1.25;
const PAD = 32;
const ARROW = 48;
export const VIEWER_HINT = '⌘ + scroll or pinch to zoom · drag to move · Esc to close';

const clamp = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/** The drawing's own size: its viewBox, else its width/height, else a sane default. */
export function naturalSize(svg: SVGSVGElement): { w: number; h: number } {
  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2]! > 0 && box[3]! > 0) return { w: box[2]!, h: box[3]! };
  const w = parseFloat(svg.getAttribute('width') ?? '');
  const h = parseFloat(svg.getAttribute('height') ?? '');
  return w > 0 && h > 0 ? { w, h } : { w: 400, h: 300 };
}

/**
 * A copy of the drawing for the viewer with ids of its own: the chat's copy stays on the page
 * behind, and two elements with one id would make arrows find the other drawing's markers.
 */
export function viewerCopy(svg: SVGSVGElement, prefix: string): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const renamed = new Map<string, string>();
  for (const el of Array.from(copy.querySelectorAll('[id]'))) {
    renamed.set(el.id, `${prefix}${el.id}`);
    el.id = `${prefix}${el.id}`;
  }
  if (renamed.size) {
    for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        if (!attr.value.includes('#')) continue;
        const next = attr.value
          .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (whole, q: string, id: string) => (renamed.has(id) ? `url(${q}#${renamed.get(id)}${q})` : whole))
          .replace(/^#(.+)$/, (whole, id: string) => (renamed.has(id) ? `#${renamed.get(id)}` : whole));
        if (next !== attr.value) el.setAttribute(attr.name, next);
      }
    }
  }
  copy.style.maxWidth = 'none';
  copy.style.display = 'block';
  return copy;
}

interface View { scale: number; x: number; y: number }

export function DiagramViewer({ open, onClose, svg, source }: {
  open: boolean;
  onClose: () => void;
  /** The drawn diagram (copied, never moved out of the page). */
  svg: SVGSVGElement | null;
  source: string;
}) {
  // The keys work at once: the drawing, not the first button, has the focus when it opens.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  return (
    <Modal open={open && !!svg} onClose={onClose} title="Diagram" bare className="kb-dviewer" testId="diagram-viewer"
      initialFocusRef={canvasRef}>
      {svg && <ViewerBody svg={svg} source={source} onClose={onClose} canvas={canvasRef} />}
    </Modal>
  );
}

function ViewerBody({ svg, source, onClose, canvas }: {
  svg: SVGSVGElement; source: string; onClose: () => void; canvas: MutableRefObject<HTMLDivElement | null>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const drawing = useRef<SVGSVGElement | null>(null);
  const natural = useRef(naturalSize(svg));
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitted = useRef(true);
  const [used, setUsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);

  const rect = () => canvas.current?.getBoundingClientRect() ?? null;

  const fitView = useCallback((): View => {
    const r = rect();
    const { w, h } = natural.current;
    if (!r || r.width <= 0 || r.height <= 0) return { scale: 1, x: 0, y: 0 };
    const scale = clamp(Math.min((r.width - 2 * PAD) / w, (r.height - 2 * PAD) / h));
    return { scale, x: (r.width - w * scale) / 2, y: (r.height - h * scale) / 2 };
  }, []);

  const set = (next: View, fit = false) => { fitted.current = fit; setView(next); };
  const touch = () => setUsed(true);

  /** Zoom to `scale` keeping the canvas point (px, py) where it is. */
  const zoomTo = (scale: number, px?: number, py?: number) => {
    const cur = viewRef.current;
    const r = rect();
    const cx = px ?? (r ? r.width / 2 : 0);
    const cy = py ?? (r ? r.height / 2 : 0);
    const next = clamp(scale);
    const k = next / cur.scale;
    set({ scale: next, x: cx - (cx - cur.x) * k, y: cy - (cy - cur.y) * k });
  };
  const zoomBy = (factor: number, px?: number, py?: number) => zoomTo(viewRef.current.scale * factor, px, py);
  const fit = () => set(fitView(), true);
  const pan = (dx: number, dy: number) => { const cur = viewRef.current; set({ ...cur, x: cur.x + dx, y: cur.y + dy }, false); };

  // The copy goes in once; it opens fitted to the window.
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const copy = viewerCopy(svg, 'skaz-dv-');
    drawing.current = copy;
    node.replaceChildren(copy);
    natural.current = naturalSize(svg);
    set(fitView(), true);
  }, [svg, fitView]);

  // The SVG is resized itself (vectors), never scaled as a picture.
  useLayoutEffect(() => {
    const copy = drawing.current;
    if (!copy) return;
    copy.setAttribute('width', String(natural.current.w * view.scale));
    copy.setAttribute('height', String(natural.current.h * view.scale));
  }, [view.scale]);

  // A fitted view stays fitted when the window changes size.
  useEffect(() => {
    const onResize = () => { if (fitted.current) setView(fitView()); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitView]);

  // Wheel: not passive, so ⌘+scroll / pinch zoom the diagram instead of the page.
  useEffect(() => {
    const node = canvas.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      touch();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      if (event.ctrlKey || event.metaKey) {
        const r = node.getBoundingClientRect();
        // A pinch sends small deltas with ctrlKey; ⌘ + a wheel notch sends ~100.
        const speed = event.ctrlKey && !event.metaKey ? 0.01 : 0.002;
        const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
        zoomBy(Math.exp(-delta * speed), event.clientX - r.left, event.clientY - r.top);
        return;
      }
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      pan(-dx * unit, -dy * unit);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey) return;
    const step = event.shiftKey ? ARROW * 4 : ARROW;
    const act: Record<string, () => void> = {
      '+': () => zoomBy(STEP), '=': () => zoomBy(STEP), '-': () => zoomBy(1 / STEP), _: () => zoomBy(1 / STEP), 0: fit,
      ArrowLeft: () => pan(step, 0), ArrowRight: () => pan(-step, 0), ArrowUp: () => pan(0, step), ArrowDown: () => pan(0, -step),
    };
    const run = act[event.key];
    if (!run) return;
    event.preventDefault();
    touch();
    run();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const cur = viewRef.current;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: cur.x, vy: cur.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add('is-dragging');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    if (event.clientX !== d.x || event.clientY !== d.y) touch();
    set({ ...viewRef.current, x: d.vx + event.clientX - d.x, y: d.vy + event.clientY - d.y });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.currentTarget.classList.remove('is-dragging');
  };

  const percent = Math.round(view.scale * 100);
  const button = (fn: () => void) => () => { touch(); fn(); };

  return (
    <div className="kb-dviewer__body" onKeyDown={onKeyDown}>
      <header className="kb-dviewer__bar">
        <b className="kb-dviewer__title" aria-hidden="true">Diagram</b>
        <IconButton icon="minus" label="Zoom out" size="sm" onClick={button(() => zoomBy(1 / STEP))} />
        <span className="kb-dviewer__pct" role="status" aria-label="Zoom">{percent}%</span>
        <IconButton icon="plus" label="Zoom in" size="sm" onClick={button(() => zoomBy(STEP))} />
        <IconButton icon="fit" label="Fit" size="sm" onClick={button(fit)} />
        <Button size="sm" className="kb-dviewer__actual" aria-label="Zoom to 100%" onClick={button(() => zoomTo(1))}>100%</Button>
        <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy Mermaid source'} size="sm"
          onClick={async () => setCopied(await copyToClipboard(source))} />
        <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
      </header>
      <div ref={canvas} className="kb-dviewer__canvas" tabIndex={0} role="application"
        aria-label="Diagram canvas" aria-roledescription="zoomable diagram"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          touch();
          const r = event.currentTarget.getBoundingClientRect();
          if (fitted.current || Math.abs(viewRef.current.scale - fitView().scale) < 0.005) zoomTo(1, event.clientX - r.left, event.clientY - r.top);
          else fit();
        }}>
        <div ref={host} className="kb-dviewer__drawing" style={{ left: view.x, top: view.y }} />
        {!used && <p className="kb-dviewer__hint">{VIEWER_HINT}</p>}
      </div>
    </div>
  );
}
