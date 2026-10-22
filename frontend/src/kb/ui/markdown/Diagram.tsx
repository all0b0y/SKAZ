import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '../Button';
import { Icon } from '../Icon';
import { DiagramViewer } from './DiagramViewer';
import { markdownParser, type SyntaxNode } from './parser';

/**
 * D: Mermaid diagrams drawn by Pele (npm `pele`, pinned, bundled — no network). Diagram text is
 * untrusted (the model wrote it): Pele escapes it and filters links/styles; links and images are
 * off here, and its SVG passes one more check before it enters the page (`safeSvg`). The SVG is
 * themed by CSS variables (styles/diagram.css → SKAZ tokens), so light/dark need no re-render.
 * A diagram that can't be drawn shows its Mermaid text and a short error as text, never as HTML.
 */

/** Asks the chat's agent to fix a diagram: resolves null when sent, else why not. */
export type DiagramFix = (source: string, error: string) => Promise<string | null>;

const DiagramFixContext = createContext<DiagramFix | null>(null);
/** Where an answer's diagrams can ask the agent for a fix (a chat); elsewhere there is no button. */
export const DiagramFixProvider = DiagramFixContext.Provider;

/** Pele's own limits for untrusted diagrams (its defaults, stated here so they stay ours). */
const SOURCE_LIMIT = 50_000;
const EDGE_LIMIT = 5_000;
const ERROR_CHARS = 200;

/** A ```mermaid fence that is closed: one still streaming stays code until its ``` arrives. */
export function isMermaidFence(node: SyntaxNode, src: string): boolean {
  if (node.name !== 'FencedCode') return false;
  const info = node.getChild('CodeInfo');
  if (!info || src.slice(info.from, info.to).trim().toLowerCase() !== 'mermaid') return false;
  return node.getChildren('CodeMark').length >= 2;
}

export function fenceCode(node: SyntaxNode, src: string): string {
  return node.getChildren('CodeText').map((c) => src.slice(c.from, c.to)).join('\n');
}

/** The closed ```mermaid fences of a Markdown text, in order. */
export function mermaidSources(text: string): string[] {
  const out: string[] = [];
  const cursor = markdownParser.parse(text).cursor();
  do {
    if (cursor.name === 'FencedCode' && isMermaidFence(cursor.node, text)) out.push(fenceCode(cursor.node, text));
  } while (cursor.next());
  return out;
}

/** Pele's message, short: the first line and the last (where the parser says what it expected). */
function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && l !== '^');
  const text = lines.length > 1 ? `${lines[0]!.replace(/:$/, '')}: ${lines.at(-1)}` : (lines[0] ?? 'Unknown error');
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS - 1)}…` : text;
}

const LINK_ATTR = /^(?:href|xlink:href|src)$/i;
/** Never in a Pele diagram: script/foreign content, media, styles, and SMIL animation (which can set
 * href/style later) — compared by lower-case local name, so SVG's camelCase names match too. */
const REMOVED = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'audio', 'video', 'style',
  'set', 'animate', 'animatetransform', 'animatemotion', 'animatecolor', 'discard',
]);
/** CSS that can load a resource: url(...) not pointing inside the drawing, and any image-set(). */
const LOADS = (value: string) => (/url\(/i.test(value) && /url\(\s*['"]?(?!#)/i.test(value)) || /image-set\(/i.test(value);

/**
 * Pele's SVG as a detached element, or null. Parsed in an inert <template> (nothing loads or runs
 * there), then held to what a Pele diagram is: one <svg>, no script/foreign content, no handlers,
 * no link that leaves the drawing.
 */
export function safeSvg(markup: string, doc: Document = document): SVGSVGElement | null {
  const template = doc.createElement('template');
  template.innerHTML = markup;
  const root = template.content.firstElementChild;
  if (!root || template.content.childElementCount !== 1 || root.localName !== 'svg') return null;
  Array.from(root.querySelectorAll('*')).filter((el) => REMOVED.has(el.localName.toLowerCase())).forEach((el) => el.remove());
  for (const anchor of Array.from(root.querySelectorAll('a'))) anchor.replaceWith(...Array.from(anchor.childNodes));
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const value = attr.value.trim();
      if (/^on/i.test(attr.name) || /javascript:|data:/i.test(value)
        || (LINK_ATTR.test(attr.name) && !value.startsWith('#'))
        || LOADS(value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.importNode(root, true) as unknown as SVGSVGElement;
}

type Drawn = { svg: SVGSVGElement } | { error: string };

/** Pele is loaded on the first diagram, each diagram type's parser when it is first drawn. */
async function drawDiagram(source: string, idPrefix: string, fontFamily: string | undefined): Promise<Drawn> {
  try {
    const { renderAsync } = await import('pele/lazy');
    const result = await renderAsync(source, {
      links: false, images: false, idPrefix, fontFamily, limit: SOURCE_LIMIT, maxEdges: EDGE_LIMIT,
    });
    const svg = safeSvg(result.svg);
    return svg ? { svg } : { error: 'The drawing came out malformed.' };
  } catch (error) {
    return { error: shortError(error) };
  }
}

function fontOf(element: Element | null): string | undefined {
  if (!element) return undefined;
  const style = getComputedStyle(element);
  return style.getPropertyValue('--pele-font').trim() || style.fontFamily || undefined;
}

type FixState = { status: 'idle' | 'sending' | 'sent' } | { status: 'failed'; error: string };

/** One diagram. `preview` is the editor's live preview: no source repeated, no fix button. */
export function DiagramView({ source, preview = false }: { source: string; preview?: boolean }) {
  const fix = useContext(DiagramFixContext);
  const canvas = useRef<HTMLDivElement>(null);
  const prefix = `skaz-d${useId().replace(/[^a-zA-Z0-9]/g, '')}-`;
  const [error, setError] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [asked, setAsked] = useState<FixState>({ status: 'idle' });
  const [viewing, setViewing] = useState<SVGSVGElement | null>(null);
  const expand = useRef<HTMLButtonElement>(null);
  /** Full size over the window (2026-10-21): from ⤢ or a click on the drawing; Esc comes back to ⤢. */
  const openViewer = () => {
    const svg = canvas.current?.querySelector('svg');
    if (!svg) return;
    expand.current?.focus({ preventScroll: true });
    setViewing(svg);
  };

  useEffect(() => {
    let live = true;
    const host = canvas.current;
    void drawDiagram(source, prefix, fontOf(host)).then((out) => {
      if (!live || !host) return;
      if ('error' in out) {
        host.replaceChildren();
        setDrawn(false);
        setError(out.error);
        return;
      }
      host.replaceChildren(out.svg);
      setDrawn(true);
      setError(null);
    });
    return () => { live = false; };
  }, [source, prefix]);

  useEffect(() => { setAsked({ status: 'idle' }); }, [source]);

  const askFix = async () => {
    if (!fix || !error || asked.status === 'sending' || asked.status === 'sent') return;
    setAsked({ status: 'sending' });
    const failed = await fix(source, error);
    setAsked(failed ? { status: 'failed', error: failed } : { status: 'sent' });
  };

  return (
    <figure className={`kb-diagram${error ? ' is-error' : ''}${preview ? ' kb-diagram--preview' : ''}`}
      aria-label={preview ? 'Diagram preview' : 'Diagram'} aria-busy={!drawn && !error}>
      <div ref={canvas} className="kb-diagram__canvas" hidden={!!error} onClick={() => {
        // A drag that selected text is not a click on the drawing.
        if (drawn && (window.getSelection()?.isCollapsed ?? true)) openViewer();
      }} />
      {drawn && !error && (
        <div className="kb-diagram__tools">
          <IconButton ref={expand} icon="expand" label="Open full size" size="sm" onClick={openViewer} />
        </div>
      )}
      <DiagramViewer open={!!viewing} svg={viewing} source={source} onClose={() => setViewing(null)} />
      {error && (
        <>
          <p className="kb-diagram__error" role="alert">
            <Icon name="warning" size={14} />
            <span>Couldn’t draw this diagram: {error}</span>
          </p>
          {!preview && <pre className="kb-diagram__source" aria-label="Diagram source"><code>{source}</code></pre>}
          {!preview && fix && (
            <div className="kb-diagram__actions">
              <Button size="sm" icon="models" busy={asked.status === 'sending'} disabled={asked.status === 'sent'}
                onClick={() => void askFix()}>
                {asked.status === 'sent' ? 'Asked the agent' : 'Ask the agent to fix'}
              </Button>
              {asked.status === 'failed' && <span className="kb-inline-error kb-inline-error--flat" role="alert">{asked.error}</span>}
            </div>
          )}
        </>
      )}
    </figure>
  );
}

/** The live preview under an editor: every closed ```mermaid fence of the text being edited. */
export function DiagramPreviews({ text }: { text: string }) {
  const sources = useMemo(() => mermaidSources(text), [text]);
  if (!sources.length) return null;
  return (
    <div className="kb-diagram-previews">
      {sources.map((source, i) => <DiagramView key={i} source={source} preview />)}
    </div>
  );
}
