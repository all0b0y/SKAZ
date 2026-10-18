import { Fragment, type ReactNode } from 'react';
import { MathView } from './MathView';
import { markdownParser, mathSource, type SyntaxNode } from './parser';

/**
 * The one safe Markdown renderer of the app (H4): chat answers, wiki pages and notes. The GFM parser
 * the app already ships (@lezer/markdown, plus math) walked into React elements. Raw HTML is shown as
 * text, images are not loaded, links open only for http(s) (or the caller's in-app links).
 *
 * Inline slots (source chips, footnote numbers) are never written into the Markdown text: a
 * placeholder character next to `**bold.**` stopped the bold from closing (CommonMark flanking).
 * The text is parsed on its own and each slot is placed at its offset while the tree is rendered.
 */

/** Renders a Markdown link whose URL is an in-app address (a wiki block's `skaz-page:` link), or null. */
export type InAppLink = (href: string, label: ReactNode, key: string) => ReactNode | null;

export interface MarkdownOptions {
  /** Renders slot `index` (a chip, a footnote mark) where it stood in the text. */
  slot?: (index: number, key: string) => ReactNode;
  inAppLink?: InAppLink;
  linkClassName?: string;
  theadClassName?: string;
}

/** `index` is what the caller renders (one footnote number may stand in several places); `id` is unique. */
interface Slot { at: number; index: number; id: number }

interface Ctx extends MarkdownOptions {
  src: string;
  /** Slots by offset in `src`, in order; `done` holds the ids of the ones already placed. */
  slots: ReadonlyArray<Slot>;
  done: Set<number>;
}

/** Nodes whose own source text between children is the visible content. */
const INLINE = new Set(['Paragraph', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link', 'TableCell', 'Task',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2']);
/** Syntax, not content. */
const SKIP = new Set(['EmphasisMark', 'HeaderMark', 'ListMark', 'QuoteMark', 'CodeMark', 'CodeInfo', 'LinkMark',
  'LinkLabel', 'LinkTitle', 'TableDelimiter', 'TaskMarker', 'StrikethroughMark', 'ProcessingInstructionBlock',
  'CommentBlock', 'Comment', 'LinkReference']);

/** Inline nodes closed by their own marks (`**`, `~~`, `](url)`). */
const MARKED = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link']);

/** The slots at offsets `from`…`to` (both ends included) that aren't placed yet, marked placed. */
function take(ctx: Ctx, from: number, to: number): Slot[] {
  const out = ctx.slots.filter((s) => s.at >= from && s.at <= to && !ctx.done.has(s.id));
  for (const s of out) ctx.done.add(s.id);
  return out;
}

/** Source text `from`…`to` with the slots that stand inside it (at `to` too, unless `openEnd`). */
function text(ctx: Ctx, from: number, to: number, key: string, openEnd = false): ReactNode {
  const slots = ctx.slot ? take(ctx, from, openEnd ? to - 1 : to) : [];
  if (!slots.length) return ctx.src.slice(from, to);
  const out: ReactNode[] = [];
  let last = from;
  for (const s of slots) {
    if (s.at > last) out.push(ctx.src.slice(last, s.at));
    out.push(ctx.slot!(s.index, `${key}-s${s.id}`));
    last = s.at;
  }
  if (to > last) out.push(ctx.src.slice(last, to));
  return <Fragment key={key}>{out}</Fragment>;
}

/** Slots that stand between blocks (after a blank line): their own paragraph. */
function between(ctx: Ctx, from: number, to: number, key: string): ReactNode {
  const slots = ctx.slot ? take(ctx, from, to) : [];
  if (!slots.length) return null;
  return <p key={key}>{slots.map((s) => ctx.slot!(s.index, `${key}-s${s.id}`))}</p>;
}

function children(node: SyntaxNode, ctx: Ctx, inline: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = node.from;
  let child = node.firstChild;
  while (child) {
    if (inline && child.from >= pos) out.push(text(ctx, pos, child.from, `t${pos}`));
    else if (!inline && child.from > pos) out.push(between(ctx, pos, child.from - 1, `g${pos}`));
    if (!SKIP.has(child.name) && !(node.name === 'Link' && child.name === 'URL')) out.push(render(child, ctx));
    pos = child.to;
    child = child.nextSibling;
  }
  // A slot right after `**bold**` belongs after it, in the parent: marked spans don't take their end.
  if (inline) out.push(text(ctx, pos, node.to, `t${pos}`, MARKED.has(node.name)));
  else if (node.name === 'Document') out.push(between(ctx, pos, node.to, `g${pos}`));
  if (inline && node.name.includes('Heading')) {
    const first = out.findIndex((part) => part !== '');
    if (typeof out[first] === 'string') out[first] = out[first].trimStart();
  }
  return out.filter((part) => part !== '' && part !== null);
}

/** An ordered list keeps the number it starts at ("3. three" stays 3). */
function listStart(node: SyntaxNode, src: string): number | undefined {
  const mark = node.firstChild?.getChild('ListMark');
  const n = mark ? Number.parseInt(src.slice(mark.from, mark.to), 10) : NaN;
  return Number.isFinite(n) && n !== 1 ? n : undefined;
}

export function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function ExternalLink({ href, label, className }: { href: string | null; label: ReactNode; className?: string }) {
  if (!href) return <>{label}</>;
  // The main process hands window.open to the OS browser for http(s) only.
  return <a href={href} title={href} className={className} rel="noreferrer noopener"
    onClick={(e) => { e.preventDefault(); window.open(href, '_blank', 'noopener'); }}>{label}</a>;
}

function render(node: SyntaxNode, ctx: Ctx): ReactNode {
  const key = `${node.name}-${node.from}`;
  const slice = ctx.src.slice(node.from, node.to);
  const inner = () => children(node, ctx, INLINE.has(node.name));
  switch (node.name) {
    case 'Document': return inner();
    case 'Paragraph': return <p key={key}>{inner()}</p>;
    case 'ATXHeading1': case 'SetextHeading1': return <h3 key={key}>{inner()}</h3>;
    case 'ATXHeading2': case 'SetextHeading2': return <h4 key={key}>{inner()}</h4>;
    case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6': return <h5 key={key}>{inner()}</h5>;
    case 'Emphasis': return <em key={key}>{inner()}</em>;
    case 'StrongEmphasis': return <strong key={key}>{inner()}</strong>;
    case 'Strikethrough': return <del key={key}>{inner()}</del>;
    case 'InlineCode': return <code key={key}>{slice.replace(/^`+|`+$/g, '')}</code>;
    case 'InlineMath': return <MathView key={key} tex={mathSource(slice)} display={false} />;
    case 'DisplayMath': case 'BlockMath': return <MathView key={key} tex={mathSource(slice)} display />;
    case 'BulletList': return <ul key={key}>{inner()}</ul>;
    case 'OrderedList': return <ol key={key} start={listStart(node, ctx.src)}>{inner()}</ol>;
    case 'ListItem': return <li key={key}>{inner()}</li>;
    case 'Task': return <Fragment key={key}>
      <input type="checkbox" disabled checked={/^\[[xX]\]/.test(slice)} aria-label="Task" /> {inner()}
    </Fragment>;
    case 'Blockquote': return <blockquote key={key}>{inner()}</blockquote>;
    case 'HorizontalRule': return <hr key={key} />;
    case 'HardBreak': return <br key={key} />;
    case 'Escape': return slice.slice(1);
    case 'FencedCode': case 'CodeBlock': {
      const code = node.getChildren('CodeText').map((c) => ctx.src.slice(c.from, c.to)).join('\n');
      return <pre key={key} className="md__code"><code>{code}</code></pre>;
    }
    case 'Link': {
      const url = node.getChild('URL');
      const own = url && ctx.inAppLink ? ctx.inAppLink(ctx.src.slice(url.from, url.to), inner(), key) : null;
      if (own) return own;
      return <ExternalLink key={key} className={ctx.linkClassName} href={url ? safeUrl(ctx.src.slice(url.from, url.to)) : null} label={inner()} />;
    }
    case 'URL': case 'Autolink': {
      const raw = slice.replace(/^<|>$/g, '');
      return <ExternalLink key={key} className={ctx.linkClassName} href={safeUrl(raw)} label={raw} />;
    }
    // Images are not loaded: the model paraphrases untrusted text, and a remote image is a request
    // the user never made. Its description stays as text.
    case 'Image': return slice.replace(/^!\[|\]\([^)]*\)$/g, '');
    case 'Table': return <div key={key} className="md__table"><table><tbody>{inner()}</tbody></table></div>;
    case 'TableHeader': return <tr key={key} className={ctx.theadClassName}>{node.getChildren('TableCell').map((c) =>
      <th key={c.from}>{children(c, ctx, true)}</th>)}</tr>;
    case 'TableRow': return <tr key={key}>{node.getChildren('TableCell').map((c) =>
      <td key={c.from}>{children(c, ctx, true)}</td>)}</tr>;
    // Raw HTML is never interpreted: it is shown as the text the model wrote.
    default: return text(ctx, node.from, node.to, key);
  }
}

/**
 * Markdown from `pieces`: text strings, and slot indexes standing where they were in the text.
 */
export function MarkdownView({ pieces, className, ...options }: MarkdownOptions & {
  pieces: ReadonlyArray<string | number>;
  className: string;
}) {
  let src = '';
  const slots: Slot[] = [];
  for (const piece of pieces) {
    if (typeof piece === 'number') slots.push({ at: src.length, index: piece, id: slots.length });
    else src += piece;
  }
  const ctx: Ctx = { ...options, src, slots, done: new Set() };
  const body = render(markdownParser.parse(src).topNode, ctx);
  // A slot inside syntax that shows no text (a link's URL): still shown, after the text.
  const rest = options.slot ? slots.filter((s) => !ctx.done.has(s.id)) : [];
  return <div className={className}>{body}{rest.length > 0 && <p>{rest.map((s) => options.slot!(s.index, `rest-${s.id}`))}</p>}</div>;
}
