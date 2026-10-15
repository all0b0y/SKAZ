import type { KbSnippetPart } from '../../api/kb/types.gen';

/** Backend snippet with its matches marked (shape + weight, not colour alone). */
export function Snippet({ parts }: { parts: KbSnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.match ? <mark key={i} className="kb-hl">{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Mark every case-insensitive occurrence of `query` in a plain title. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const needle = q.toLocaleLowerCase();
  const out: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  for (let i = lower.indexOf(needle); i >= 0 && needle; i = lower.indexOf(needle, from)) {
    if (i > from) out.push({ text: text.slice(from, i), match: false });
    out.push({ text: text.slice(i, i + needle.length), match: true });
    from = i + needle.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return <Snippet parts={out} />;
}
