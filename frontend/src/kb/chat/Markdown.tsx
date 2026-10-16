import { Fragment, type ReactNode } from 'react';
import { GFM, parser as baseParser } from '@lezer/markdown';

/**
 * Safe Markdown for answers — the same approach as AnswerMarkdown (kb/ui/AnswerMarkdown.tsx, used
 * for wiki page blocks): the GFM parser the app already ships
 * (@lezer/markdown) walked into React elements. Raw HTML is shown as text, images are not loaded,
 * links open only for http(s). Adapted (not imported) because answers here carry inline parts —
 * source and page chips — inside a paragraph, which AnswerMarkdown cannot place.
 */
const parser = baseParser.configure(GFM);
type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

const SLOT_OPEN = '\uE010';
const SLOT_CLOSE = '\uE011';
const SLOT = new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, 'g');

const INLINE = new Set(['Paragraph', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link', 'TableCell', 'Task',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2']);
const SKIP = new Set(['EmphasisMark', 'HeaderMark', 'ListMark', 'QuoteMark', 'CodeMark', 'CodeInfo', 'LinkMark',
  'LinkLabel', 'LinkTitle', 'TableDelimiter', 'TaskMarker', 'StrikethroughMark', 'ProcessingInstructionBlock',
  'CommentBlock', 'Comment', 'LinkReference']);

interface Ctx {
  src: string;
  slot: (index: number, key: string) => ReactNode;
}

function text(value: string, ctx: Ctx, key: string): ReactNode {
  if (!value.includes(SLOT_OPEN)) return value;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of value.matchAll(SLOT)) {
    if (match.index > last) out.push(value.slice(last, match.index));
    out.push(ctx.slot(Number(match[1]), `${key}-s${match.index}`));
    last = match.index + match[0].length;
  }
  if (last < value.length) out.push(value.slice(last));
  return <Fragment key={key}>{out}</Fragment>;
}

function children(node: SyntaxNode, ctx: Ctx, inline: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = node.from;
  let child = node.firstChild;
  while (child) {
    if (inline && child.from > pos) out.push(text(ctx.src.slice(pos, child.from), ctx, `t${pos}`));
    if (!SKIP.has(child.name) && !(node.name === 'Link' && child.name === 'URL')) out.push(render(child, ctx));
    pos = child.to;
    child = child.nextSibling;
  }
  if (inline && node.to > pos) out.push(text(ctx.src.slice(pos, node.to), ctx, `t${pos}`));
  if (inline && node.name.includes('Heading') && typeof out[0] === 'string') out[0] = out[0].trimStart();
  return out;
}

/** An ordered list keeps the number it starts at ("3. three" stays 3). */
function listStart(node: SyntaxNode, src: string): number | undefined {
  const mark = node.firstChild?.getChild('ListMark');
  const n = mark ? Number.parseInt(src.slice(mark.from, mark.to), 10) : NaN;
  return Number.isFinite(n) && n !== 1 ? n : undefined;
}

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function ExternalLink({ href, label }: { href: string | null; label: ReactNode }) {
  if (!href) return <>{label}</>;
  // The main process hands window.open to the OS browser for http(s) only.
  return <a href={href} title={href} className="kb-md__link" rel="noreferrer noopener"
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
    case 'InlineCode': return <code key={key}>{text(slice.replace(/^`+|`+$/g, ''), ctx, key)}</code>;
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
      return <ExternalLink key={key} href={url ? safeUrl(ctx.src.slice(url.from, url.to)) : null} label={inner()} />;
    }
    case 'URL': case 'Autolink': {
      const raw = slice.replace(/^<|>$/g, '');
      return <ExternalLink key={key} href={safeUrl(raw)} label={raw} />;
    }
    // Images are not loaded: a remote image is a request the user never made.
    case 'Image': return text(slice.replace(/^!\[|\]\([^)]*\)$/g, ''), ctx, key);
    case 'Table': return <div key={key} className="md__table"><table><tbody>{inner()}</tbody></table></div>;
    case 'TableHeader': return <tr key={key}>{node.getChildren('TableCell').map((c) =>
      <th key={c.from}>{children(c, ctx, true)}</th>)}</tr>;
    case 'TableRow': return <tr key={key}>{node.getChildren('TableCell').map((c) =>
      <td key={c.from}>{children(c, ctx, true)}</td>)}</tr>;
    // Raw HTML is never interpreted: it is shown as the text the model wrote.
    default: return text(slice, ctx, key);
  }
}

/**
 * Render Markdown whose inline slots (`slots[i]`, e.g. chips) sit inside the text where they were
 * in the answer. `pieces` alternate text and slot indexes.
 */
export function InlineMarkdown({ pieces, slot }: {
  pieces: ReadonlyArray<string | number>;
  slot: (index: number, key: string) => ReactNode;
}) {
  // A private-use placeholder the model never produces; stripped from the text first just in case.
  const src = pieces.map((p) => (typeof p === 'number' ? `${SLOT_OPEN}${p}${SLOT_CLOSE}` : p.replace(/[\uE010\uE011]/g, ''))).join('');
  return <div className="kb-md">{render(parser.parse(src).topNode, { src, slot })}</div>;
}
