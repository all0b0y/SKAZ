import type { Citation } from '../../api/types';
import { formatTimecode } from '../../lib/time';
import { answerFootnotes, MARK_CLOSE, MARK_OPEN, type Footnote } from '../../lib/answerFootnotes';
import { MarkdownView, type InAppLink } from './markdown/Markdown';

const MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g');
const QUOTE_PREVIEW = 90;

export type { InAppLink };

function footnoteTitle(footnote: Footnote, activeSessionId: string | null): string {
  const first = footnote.citations[0]!;
  const last = footnote.citations.at(-1)!;
  const where = first.session_title && first.session_id && first.session_id !== activeSessionId ? `${first.session_title} · ` : '';
  const time = first === last ? formatTimecode(first.start_ms) : `${formatTimecode(first.start_ms)}–${formatTimecode(last.end_ms)}`;
  const quote = first.text.length > QUOTE_PREVIEW ? `${first.text.slice(0, QUOTE_PREVIEW).trimEnd()}…` : first.text;
  return `${where}${time} — ${quote}`;
}

/** The footnote marks out of the text: text pieces and footnote numbers, in order. */
function piecesOf(text: string): Array<string | number> {
  const out: Array<string | number> = [];
  let last = 0;
  for (const match of text.matchAll(MARK)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AnswerMarkdown({ content, citations, activeSessionId, onCite, inAppLink }: {
  content: string;
  citations?: Citation[];
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
  inAppLink?: InAppLink;
}) {
  const { text: body, footnotes, legacy } = answerFootnotes(content, citations);
  const byNumber = new Map(footnotes.map((f) => [f.n, f]));
  const mark = (n: number, key: string) => {
    const footnote = byNumber.get(n);
    if (!footnote) return null;
    const title = footnoteTitle(footnote, activeSessionId);
    return <sup key={key} className="footnote">
      <button type="button" className="footnote__ref tabular" title={title} aria-label={`Source ${n}: ${title}`}
        onClick={() => onCite(footnote.citations[0]!)}>{n}</button>
    </sup>;
  };
  return <>
    <MarkdownView className="md" pieces={piecesOf(body)} slot={mark} inAppLink={inAppLink} theadClassName="md__thead" />
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
