import { Fragment, type ReactNode } from 'react';
import { GFM, parser as baseParser } from '@lezer/markdown';
import type { Citation } from '../../api/types';
import { formatTimecode } from '../../lib/time';
import { answerFootnotes, MARK_CLOSE, MARK_OPEN, type Footnote } from '../../lib/answerFootnotes';

// Same GFM parser the notes editor already ships (@lezer/markdown): no extra dependency.
const parser = baseParser.configure(GFM);
type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
const MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g');
const QUOTE_PREVIEW = 90;

/** Nodes whose own source text between children is the visible content. */
const INLINE = new Set(['Paragraph', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link', 'TableCell', 'Task',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2']);
/** Syntax, not content. */
const SKIP = new Set(['EmphasisMark', 'HeaderMark', 'ListMark', 'QuoteMark', 'CodeMark', 'CodeInfo', 'LinkMark',
  'LinkLabel', 'LinkTitle', 'TableDelimiter', 'TaskMarker', 'StrikethroughMark', 'ProcessingInstructionBlock',
  'CommentBlock', 'Comment', 'LinkReference']);

interface Ctx {
  src: string;
  footnotes: Map<number, Footnote>;
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
}

function footnoteTitle(footnote: Footnote, activeSessionId: string | null): string {
  const first = footnote.citations[0]!;
  const last = footnote.citations.at(-1)!;
  const where = first.session_title && first.session_id && first.session_id !== activeSessionId ? `${first.session_title} · ` : '';
  const time = first === last ? formatTimecode(first.start_ms) : `${formatTimecode(first.start_ms)}–${formatTimecode(last.end_ms)}`;
  const quote = first.text.length > QUOTE_PREVIEW ? `${first.text.slice(0, QUOTE_PREVIEW).trimEnd()}…` : first.text;
  return `${where}${time} — ${quote}`;
}

/** Plain text with footnote placeholders turned into clickable superscripts. */
function text(value: string, ctx: Ctx, key: string): ReactNode {
  if (!value.includes(MARK_OPEN)) return value;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of value.matchAll(MARK)) {
    if (match.index > last) parts.push(value.slice(last, match.index));
    const n = Number(match[1]);
    const footnote = ctx.footnotes.get(n);
    if (footnote) {
      parts.push(<sup key={`${key}-${match.index}`} className="footnote">
        <button type="button" className="footnote__ref tabular" title={footnoteTitle(footnote, ctx.activeSessionId)}
          aria-label={`Source ${n}: ${footnoteTitle(footnote, ctx.activeSessionId)}`}
          onClick={() => ctx.onCite(footnote.citations[0]!)}>{n}</button>
      </sup>);
    }
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return <Fragment key={key}>{parts}</Fragment>;
}

function children(node: SyntaxNode, ctx: Ctx, inline: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = node.from;
  let child = node.firstChild;
  // Heading/marker gaps start with the separating space; the node end is trimmed below.
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

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function ExternalLink({ href, label }: { href: string | null; label: ReactNode }) {
  if (!href) return <>{label}</>;
  // The main process hands window.open to the OS browser for http(s) only.
  return <a href={href} title={href} rel="noreferrer noopener"
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
    case 'OrderedList': return <ol key={key}>{inner()}</ol>;
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
    // Images are not loaded: the model paraphrases untrusted speech, and a remote
    // image is a request the user never made. Its description stays as text.
    case 'Image': return text(slice.replace(/^!\[|\]\([^)]*\)$/g, ''), ctx, key);
    case 'Table': return <div key={key} className="md__table"><table><tbody>{inner()}</tbody></table></div>;
    case 'TableHeader': return <tr key={key} className="md__thead">{node.getChildren('TableCell').map((c) =>
      <th key={c.from}>{children(c, ctx, true)}</th>)}</tr>;
    case 'TableRow': return <tr key={key}>{node.getChildren('TableCell').map((c) =>
      <td key={c.from}>{children(c, ctx, true)}</td>)}</tr>;
    // Raw HTML is never interpreted: it is shown as the text the model wrote.
    default: return text(slice, ctx, key);
  }
}

export function AnswerMarkdown({ content, citations, activeSessionId, onCite }: {
  content: string;
  citations?: Citation[];
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
}) {
  const { text: body, footnotes, legacy } = answerFootnotes(content, citations);
  const ctx: Ctx = { src: body, footnotes: new Map(footnotes.map((f) => [f.n, f])), activeSessionId, onCite };
  return <>
    <div className="md">{render(parser.parse(body).topNode, ctx)}</div>
    {legacy.length > 0 && (
      <div className="msg__cites" aria-label="Answer sources">
        <span className="msg__cites-label">Answer sources</span>
        {legacy.map((c, i) => (
          <button key={`${c.segment_id}-${i}`} type="button" className="cite tabular" onClick={() => onCite(c)} title={c.text}>
            {c.session_title && c.session_id !== activeSessionId && `${c.session_title} · `}{formatTimecode(c.start_ms)}
          </button>
        ))}
      </div>
    )}
  </>;
}
