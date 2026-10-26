import { clip } from './model';

/**
 * P2: which nodes and edges of a drawn Mermaid diagram can be picked, addressed by the ids of the
 * diagram's SOURCE (decision: never by SVG internals). Only flowcharts (`flowchart` / `graph`) are
 * read; in other diagram types nothing is selectable. A node is selectable when its id is defined in
 * the source and exactly one drawn node carries it; an edge when its pair of ends occurs once in the
 * source and exactly one drawn edge can be that pair — duplicated edges, ambiguous ids and statements
 * this small reader doesn't understand are left unselectable rather than guessed.
 *
 * Item ids: `node:<id>`, `edge:<from>-><to>` (Mermaid ids hold no `>`).
 */

export interface FlowNode { id: string; label: string }
export interface FlowEdge { from: string; to: string; label: string }
export interface Flowchart { nodes: Map<string, FlowNode>; edges: FlowEdge[] }

const HEADER = /^(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?\s*;?$/i;
const SKIP = /^(?:subgraph\b|end\b|direction\s|classDef\s|class\s|style\s|linkStyle\s|click\s|accTitle|accDescr)/i;
const ID = /[\p{L}\p{N}_]+/uy;
/** Node shapes, longest openers first; the label is between the brackets. */
const SHAPES: Array<[string, string]> = [
  ['(((', ')))'], ['((', '))'], ['([', '])'], ['[[', ']]'], ['[(', ')]'], ['{{', '}}'],
  ['[/', '/]'], ['[\\', '\\]'], ['[/', '\\]'], ['[\\', '/]'], ['[', ']'], ['(', ')'], ['{', '}'], ['>', ']'],
];
/** A link, with its text inline (`-- yes -->`, `-. maybe .->`, `== sure ==>`) or none. */
const LINK_TEXT = /\s*<?(--|==|-\.)\s+([^\n]*?)\s+(-{2,}>|-{3,}|={2,}>|={3,}|\.+->|\.+-|-{2,}[xo]|={2,}[xo])\s*/y;
const LINK = /\s*<?(-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|-{2,}[xo]|={2,}[xo]|~{3,})\s*/y;
const PIPE = /\|([^|\n]*)\|\s*/y;
const AMP = /\s*&\s*/y;
const CLASS = /:::[\p{L}\p{N}_-]+/uy;

function stripQuotes(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Reads one statement; null when it isn't understood (it then contributes nothing). */
function readStatement(line: string): { nodes: FlowNode[]; edges: FlowEdge[] } | null {
  let at = 0;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const sticky = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = at;
    const m = re.exec(line);
    if (m) at = re.lastIndex;
    return m;
  };
  const node = (): FlowNode | null => {
    while (line[at] === ' ') at += 1;
    const id = sticky(ID);
    if (!id) return null;
    let label = '';
    let shaped = false;
    for (const [open, close] of SHAPES) {
      if (!line.startsWith(open, at)) continue;
      const end = line.indexOf(close, at + open.length);
      if (end < 0) continue;
      label = stripQuotes(line.slice(at + open.length, end));
      at = end + close.length;
      shaped = true;
      break;
    }
    // An opening bracket no shape closes: not understood.
    if (!shaped && /^[[({>]/.test(line.slice(at))) return null;
    sticky(CLASS);
    return { id: id[0], label };
  };
  const group = (): FlowNode[] | null => {
    const out: FlowNode[] = [];
    for (;;) {
      const n = node();
      if (!n) return null;
      out.push(n);
      if (!sticky(AMP)) return out;
    }
  };
  let left = group();
  if (!left) return null;
  nodes.push(...left);
  while (line.slice(at).trim()) {
    let text = '';
    const inline = sticky(LINK_TEXT);
    let invisible = false;
    if (inline) text = inline[2] ?? '';
    else {
      const plain = sticky(LINK);
      if (!plain) return null;
      invisible = plain[1]!.startsWith('~');
      const pipe = sticky(PIPE);
      if (pipe) text = pipe[1] ?? '';
    }
    const right = group();
    if (!right) return null;
    nodes.push(...right);
    if (!invisible) {
      for (const a of left) for (const b of right) edges.push({ from: a.id, to: b.id, label: stripQuotes(text) });
    }
    left = right;
  }
  return { nodes, edges };
}

/** The flowchart's nodes and edges as written; null for any other diagram type. */
export function readFlowchart(source: string): Flowchart | null {
  const lines = source.split('\n').map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!lines.length || !HEADER.test(lines[0]!)) return null;
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  for (const raw of lines.slice(1)) {
    for (const statement of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
      if (SKIP.test(statement)) continue;
      const read = readStatement(statement);
      if (!read) continue;
      for (const n of read.nodes) {
        const known = nodes.get(n.id);
        if (!known) nodes.set(n.id, n);
        else if (!known.label && n.label) nodes.set(n.id, n);
      }
      edges.push(...read.edges);
    }
  }
  return { nodes, edges };
}

export const nodeItem = (id: string) => `node:${id}`;
export const edgeItem = (from: string, to: string) => `edge:${from}->${to}`;

/**
 * Marks the selectable nodes and edges of a drawn diagram (`data-item-id`, `data-item-label`; an
 * edge's label stands for its edge) and widens each edge's click target. Returns how many items.
 */
export function markDiagram(svg: SVGSVGElement, source: string): number {
  const chart = readFlowchart(source);
  if (!chart) return 0;
  let marked = 0;
  const drawnNodes = Array.from(svg.querySelectorAll<SVGGElement>('g.pele-node[data-id]'));
  for (const node of chart.nodes.values()) {
    const drawn = drawnNodes.filter((g) => g.getAttribute('data-id') === node.id);
    if (drawn.length !== 1) continue;
    drawn[0]!.setAttribute('data-item-id', nodeItem(node.id));
    drawn[0]!.setAttribute('data-item-label', clip(node.label || node.id));
    marked += 1;
  }
  const pairs = new Map<string, FlowEdge[]>();
  for (const edge of chart.edges) {
    const key = `L_${edge.from}_${edge.to}_`;
    pairs.set(key, [...(pairs.get(key) ?? []), edge]);
  }
  const drawnEdges = Array.from(svg.querySelectorAll<SVGGElement>('g.pele-edge[data-id]'));
  const labels = Array.from(svg.querySelectorAll<SVGGElement>('g.pele-edge-label[data-id]'));
  for (const [key, list] of pairs) {
    const ofPair = (g: Element) => {
      const id = g.getAttribute('data-id') ?? '';
      return id.startsWith(key) && /^\d+$/.test(id.slice(key.length));
    };
    // Two pairs whose ids run together (a_b→c vs a→b_c) can't be told apart: neither is selectable.
    const drawn = drawnEdges.filter(ofPair);
    if (list.length !== 1 || drawn.length !== 1) continue;
    const edge = list[0]!;
    const g = drawn[0]!;
    const id = edgeItem(edge.from, edge.to);
    const from = chart.nodes.get(edge.from)?.label || edge.from;
    const to = chart.nodes.get(edge.to)?.label || edge.to;
    g.setAttribute('data-item-id', id);
    g.setAttribute('data-item-label', clip(`${from} → ${to}${edge.label ? `: ${edge.label}` : ''}`));
    const line = g.querySelector('path:not(.pele-marker)');
    if (line) {
      const hit = line.cloneNode(false) as SVGPathElement;
      hit.setAttribute('class', 'kb-sel-hit');
      hit.removeAttribute('marker-end');
      hit.removeAttribute('marker-start');
      g.insertBefore(hit, g.firstChild);
    }
    labels.filter((l) => l.getAttribute('data-id') === g.getAttribute('data-id')).forEach((l) => l.setAttribute('data-item-for', id));
    marked += 1;
  }
  return marked;
}
