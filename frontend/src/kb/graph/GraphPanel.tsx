import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { useReducedMotion } from 'motion/react';
import type { KbCitation, KbGraph } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Icon, Spinner } from '../ui';
import { CitationChip, FolderTag, PanelFrameButtons, useFolderTone } from '../document/parts';
import { plural } from '../document/text';
import { useLoad } from '../document/useLoad';
import { useLibrary, useServices, useUi } from '../state/context';
import { drawGraph, readPalette } from './draw';
import { createSim, fit, pick, reheat, settle, step, toGraph, zoomAt, type Sim, type View } from './layout';

function NodeCard({ sim, id }: { sim: Sim; id: string }) {
  const { client } = useServices();
  const openDocument = useUi((s) => s.openDocument);
  const folders = useLibrary((s) => s.folders);
  const tone = useFolderTone();
  const node = sim.byId.get(id)?.node;
  const [cites, setCites] = useState<KbCitation[] | null>(null);
  useEffect(() => {
    let live = true;
    setCites(null);
    client.call('GET /kb/wiki/pages/{page_id}', { path: { page_id: id } }).then((raw) => {
      if (!live) return;
      const seen = new Set<string>();
      const out: KbCitation[] = [];
      for (const block of raw.blocks) {
        for (const c of block.citations) {
          if (seen.has(c.material_id) || !c.available) continue;
          seen.add(c.material_id);
          out.push(c);
        }
      }
      setCites(out.slice(0, 4));
    }, () => { if (live) setCites([]); });
    return () => { live = false; };
  }, [client, id]);
  if (!node) return null;
  const links = sim.adj.get(id)?.size ?? node.degree;
  return (
    <div className="kb-gcard" aria-live="polite">
      <div className="kb-gcard__row">
        <b className="kb-gcard__title">{node.title}</b>
        {node.folder_ids.map((fid) => {
          const name = folders.find((f) => f.id === fid)?.name;
          return name ? <FolderTag key={fid} name={name} tone={tone(fid)} /> : null;
        })}
      </div>
      <div className="kb-gcard__row">
        <span className="kb-muted">{plural(links, 'connection')}</span>
        <span className="kb-head__spacer" />
        <Button size="sm" icon="concept" onClick={() => openDocument({ type: 'page', id })}>Open page</Button>
      </div>
      {cites && cites.length > 0 && (
        <div className="kb-gcard__row kb-chips">{cites.map((c) => <CitationChip key={c.material_id} citation={c} />)}</div>
      )}
    </div>
  );
}

/** Graph of connections in a wide right panel (v4/v5): canvas, own force layout, no library. */
export function GraphPanel() {
  const { client } = useServices();
  const folders = useLibrary((s) => s.folders);
  const openDocument = useUi((s) => s.openDocument);
  /** "Show the graph" from a page selects that page (QA C22). */
  const focus = useUi((s) => (s.right?.kind === 'graph' ? s.right.focus ?? null : null));
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const reduce = useReducedMotion() ?? false;
  const [folderId, setFolderId] = useState('');
  const { state, reload } = useLoad<KbGraph>(`graph:${folderId}`, () => client.call('GET /kb/graph', { query: folderId ? { folder_id: folderId } : {} }));
  const graph = state.value;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const fittedRef = useRef(false);
  /** The user has zoomed or panned: the view no longer follows the layout. */
  const userViewRef = useRef(false);
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ node: string | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const frameRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const userFolders = folders.filter((f) => !f.system);
  const slot = useCallback((id: string) => { const i = userFolders.findIndex((f) => f.id === id); return i >= 0 ? i : null; }, [userFolders]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!fittedRef.current) { viewRef.current = fit(sim, w, h); fittedRef.current = true; }
    drawGraph(ctx, sim, { view: viewRef.current, hover: hoverRef.current, selected: selectedRef.current },
      readPalette(canvas, slot), w, h);
  }, [slot]);

  /** One frame now; keep animating only while the layout is still cooling (and motion is allowed). */
  const request = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(function loop() {
      frameRef.current = 0;
      const sim = simRef.current;
      const moving = sim && !reduce ? step(sim) : false;
      // Until the user zooms or pans, the view follows the cooling layout.
      if (moving && !userViewRef.current) fittedRef.current = false;
      draw();
      if (moving) frameRef.current = requestAnimationFrame(loop);
    });
  }, [draw, reduce]);

  useEffect(() => {
    if (!graph) return;
    const sim = createSim(graph);
    // Reduced motion: the final layout at once. Otherwise a short head start, then it cools on screen.
    if (reduce) settle(sim);
    else for (let i = 0; i < 80; i += 1) step(sim);
    simRef.current = sim;
    fittedRef.current = false;
    userViewRef.current = false;
    if (reduce) { const { w, h } = sizeRef.current; if (w && h) { viewRef.current = fit(sim, w, h); fittedRef.current = true; } }
    const focused = focusRef.current;
    setSelected((s) => (s && sim.byId.has(s) ? s
      : focused && sim.byId.has(focused) ? focused
        : (sim.nodes.find((n) => n.node.hub)?.id ?? sim.nodes[0]?.id ?? null)));
    request();
  }, [graph, reduce, request]);

  useEffect(() => { if (focus && simRef.current?.byId.has(focus)) setSelected(focus); }, [focus]);
  useEffect(() => { request(); }, [selected, request]);

  // Theme changes repaint (colours are read from CSS on every frame).
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const obs = new MutationObserver(() => request());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    mq?.addEventListener?.('change', request);
    return () => { obs.disconnect(); mq?.removeEventListener?.('change', request); };
  }, [request]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      if (!userViewRef.current) fittedRef.current = false;
      request();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [request, graph]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim) return;
    const p = local(e);
    const node = pick(sim, viewRef.current, p.x, p.y);
    dragRef.current = { node: node?.id ?? null, sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim) return;
    const p = local(e);
    const drag = dragRef.current;
    if (drag) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.node) {
        const n = sim.byId.get(drag.node)!;
        const g = toGraph(viewRef.current, p.x, p.y);
        n.x = g.x; n.y = g.y; n.fixed = true;
        userViewRef.current = true;
        if (!reduce) reheat(sim);
      } else {
        viewRef.current = { ...viewRef.current, x: drag.vx + (e.clientX - drag.sx), y: drag.vy + (e.clientY - drag.sy) };
        userViewRef.current = true;
      }
      request();
      return;
    }
    const over = pick(sim, viewRef.current, p.x, p.y)?.id ?? null;
    if (over !== hoverRef.current) { hoverRef.current = over; request(); }
    e.currentTarget.style.cursor = over ? 'pointer' : 'grab';
  };
  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    const sim = simRef.current;
    if (!drag || !sim) return;
    if (drag.node) sim.byId.get(drag.node)!.fixed = false;
    if (drag.node && !drag.moved) setSelected(drag.node);
  };
  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const p = local(e);
    viewRef.current = zoomAt(viewRef.current, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    userViewRef.current = true;
    request();
  };
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim || sim.nodes.length === 0) return;
    const order = [...sim.nodes].sort((a, b) => (sim.adj.get(b.id)!.size - sim.adj.get(a.id)!.size) || a.node.title.localeCompare(b.node.title));
    const i = order.findIndex((n) => n.id === selected);
    const { w, h } = sizeRef.current;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(order[(i + 1) % order.length]!.id); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(order[(i - 1 + order.length) % order.length]!.id); }
    else if (e.key === 'Enter' && selected) { e.preventDefault(); openDocument({ type: 'page', id: selected }); }
    else if (e.key === '+' || e.key === '=') { viewRef.current = zoomAt(viewRef.current, w / 2, h / 2, 1.25); request(); }
    else if (e.key === '-') { viewRef.current = zoomAt(viewRef.current, w / 2, h / 2, 0.8); request(); }
    else if (e.key === '0') { viewRef.current = fit(sim, w, h); request(); }
  };

  // Native non-passive wheel listener so the page does not scroll while zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const stop = (e: globalThis.WheelEvent) => e.preventDefault();
    canvas.addEventListener('wheel', stop, { passive: false });
    return () => canvas.removeEventListener('wheel', stop);
  }, [graph]);

  const usedFolders = new Set(graph?.nodes.flatMap((n) => n.folder_ids) ?? []);
  const concepts = graph?.nodes.filter((n) => n.kind === 'concept').length ?? 0;
  // Notes, folder overviews and analyses are drawn too: the count says so (QA C6).
  const others = (graph?.nodes.length ?? 0) - concepts;

  return (
    <>
      <header className="kb-head kb-head--doc kb-head--graph">
        <h2 className="kb-graph__title">Graph of connections</h2>
        {graph && <span className="kb-muted kb-graph__count">{[plural(concepts, 'concept'), others > 0 ? plural(others, 'other page') : '', plural(usedFolders.size, 'folder')].filter(Boolean).join(' · ')}</span>}
        <span className="kb-head__spacer" />
        <label className="kb-select kb-select--sm">
          <span className="kb-visually-hidden">Folder</span>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">All folders</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <Icon name="chevronDown" size={12} className="kb-select__chev" />
        </label>
        <PanelFrameButtons closeLabel="Close graph" />
      </header>
      <div className="kb-graph">
        <div className="kb-graph__wrap" ref={wrapRef}>
          {state.load === 'loading' && !graph && <div className="kb-doc__wait"><Spinner label="Building the graph" /></div>}
          {state.load === 'error' && !graph && (
            <div className="kb-graph__msg">
              <Banner tone="error" title="Couldn’t build the graph." actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
            </div>
          )}
          {graph && graph.nodes.length === 0 && (
            <EmptyState icon="graph" title="No connections yet">Concepts appear here as materials are added to the wiki.</EmptyState>
          )}
          {graph && graph.nodes.length > 0 && (
            <>
              <canvas
                ref={canvasRef}
                className="kb-graph__canvas"
                data-testid="graph-canvas"
                tabIndex={0}
                role="img"
                aria-label={`Graph of ${plural(graph.nodes.length, 'page')} and ${plural(graph.edges.length, 'link')}. Arrow keys choose a node, Enter opens it.`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => { if (!dragRef.current && hoverRef.current) { hoverRef.current = null; request(); } }}
                onWheel={onWheel}
                onDoubleClick={(e) => { const sim = simRef.current; const p = local(e); const n = sim && pick(sim, viewRef.current, p.x, p.y); if (n) openDocument({ type: 'page', id: n.id }); }}
                onKeyDown={onKey}
              />
              <p className="kb-graph__hint" aria-hidden="true">wheel — zoom · drag — move · click — select</p>
            </>
          )}
        </div>
        {graph && selected && simRef.current?.byId.has(selected) && <NodeCard sim={simRef.current} id={selected} />}
        {graph && graph.nodes.length > 0 && (
          <div className="kb-graph__legend">
            {userFolders.filter((f) => usedFolders.has(f.id)).map((f) => <FolderTag key={f.id} name={f.name} tone={`var(--kb-folder-${(slot(f.id)! % 4) + 1})`} />)}
            <span className="kb-graph__key"><span className="kb-ringdot" aria-hidden="true" />rings — concept in several folders</span>
            <span className="kb-graph__key"><span className="kb-dashline" aria-hidden="true" />dashed — link across folders</span>
          </div>
        )}
      </div>
    </>
  );
}
