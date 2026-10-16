import { placeLabels, toScreen, type Sim, type View } from './layout';

export interface Palette {
  text: string;
  muted: string;
  line: string;
  pane: string;
  accent: string;
  /** Colour of a folder id; null for folders without a colour (Inbox). */
  folder: (folderId: string) => string | null;
}

export interface DrawState {
  view: View;
  hover: string | null;
  selected: string | null;
}

/** Read the theme from CSS variables of `el` (both themes; re-read on every draw). */
export function readPalette(el: Element, folderSlot: (folderId: string) => number | null): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const slots = [1, 2, 3, 4].map((i) => v(`--kb-folder-${i}`, '#2f62b0'));
  return {
    text: v('--kb-text', '#2c2e31'),
    muted: v('--kb-muted', '#686969'),
    line: v('--kb-line', '#dddedb'),
    pane: v('--kb-pane', '#fffffb'),
    accent: v('--kb-accent', '#2c2e31'),
    folder: (id) => {
      const slot = folderSlot(id);
      return slot === null ? null : slots[slot % 4]!;
    },
  };
}

/**
 * One frame: edges (dashed across folders), nodes coloured by their first folder with a ring
 * per extra folder, neighbours lit on hover, labels only where they help.
 */
export function drawGraph(ctx: CanvasRenderingContext2D, sim: Sim, state: DrawState, palette: Palette, width: number, height: number) {
  const { view, hover, selected } = state;
  const focus = hover ?? null;
  const near = focus ? sim.adj.get(focus) ?? new Set<string>() : null;
  const lit = (id: string) => !focus || id === focus || near!.has(id);
  ctx.clearRect(0, 0, width, height);

  for (const { a, b, edge } of sim.edges) {
    const hot = focus !== null && (a.id === focus || b.id === focus);
    ctx.globalAlpha = focus ? (hot ? 0.9 : 0.08) : 0.55;
    ctx.strokeStyle = hot ? palette.accent : palette.line;
    ctx.lineWidth = hot ? 1.4 : 1;
    ctx.setLineDash(edge.cross_folder ? [4, 3] : []);
    const p = toScreen(view, a);
    const q = toScreen(view, b);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const scale = Math.max(0.8, Math.min(view.k, 1.6));
  for (const n of sim.nodes) {
    const p = toScreen(view, n);
    const r = n.r * scale;
    const colours = n.node.folder_ids.map(palette.folder).filter((c): c is string => c !== null);
    ctx.globalAlpha = lit(n.id) ? 1 : 0.18;
    ctx.fillStyle = colours[0] ?? palette.muted;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.6;
    colours.slice(1).forEach((c, i) => {
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 2.4 + i * 2.6, 0, Math.PI * 2);
      ctx.stroke();
    });
    if (n.id === selected) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = palette.text;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3 + Math.max(0, colours.length - 1) * 2.6 + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const font = (bold: boolean) => `${bold ? 600 : 400} 12px 'SKAZ Inter', -apple-system, system-ui, sans-serif`;
  ctx.font = font(true); // measured bold: a label never grows into its neighbour when it becomes bold
  // Labels that would sit on each other are left out (QA C5); zooming in shows more.
  for (const label of placeLabels(sim, view, focus, selected, (text) => ctx.measureText(text).width, scale)) {
    ctx.globalAlpha = lit(label.id) ? 1 : 0.2;
    ctx.font = font(label.id === focus || label.id === selected);
    // A halo in the pane colour keeps labels readable over edges.
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.pane;
    ctx.strokeText(label.text, label.x, label.y);
    ctx.fillStyle = palette.text;
    ctx.fillText(label.text, label.x, label.y);
  }
  ctx.globalAlpha = 1;
}
