import { GFM, parser as baseParser, type BlockContext, type InlineContext, type Line, type MarkdownConfig } from '@lezer/markdown';

/**
 * Math in answers and notes (H4). Models write formulas four ways: `$…$` and `\(…\)` inline, `$$…$$`
 * and `\[…\]` on their own. Without this, `\[` and `\(` are Markdown escapes (the backslash vanished)
 * and `_`/`*` inside a formula turned into emphasis. The nodes keep their delimiters; the renderer
 * strips them and hands the TeX to KaTeX.
 */
const DOLLAR = 36;
const BACKSLASH = 92;

const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const isDigit = (code: number) => code >= 48 && code <= 57;

/** `$x$` is math, `$5 and $10` is money: pandoc's rule — no space inside the dollars, no digit after. */
function singleDollar(cx: InlineContext, pos: number): number {
  const first = cx.char(pos + 1);
  if (first < 0 || isSpace(first) || first === DOLLAR) return -1;
  for (let at = pos + 2; at < cx.end; at += 1) {
    const code = cx.char(at);
    if (code === BACKSLASH) { at += 1; continue; }
    if (code === 10 && cx.char(at + 1) === 10) return -1;
    if (code !== DOLLAR) continue;
    if (isSpace(cx.char(at - 1)) || isDigit(cx.char(at + 1))) return -1;
    return cx.addElement(cx.elt('InlineMath', pos, at + 1));
  }
  return -1;
}

function closed(cx: InlineContext, pos: number, open: number, close: string, type: string): number {
  const at = cx.slice(pos + open, cx.end).indexOf(close);
  if (at <= 0) return -1;
  return cx.addElement(cx.elt(type, pos, pos + open + at + close.length));
}

/** The opener of a display formula that starts a line, and the closer it waits for. */
function blockOpener(line: Line): { open: string; close: string } | null {
  const rest = line.text.slice(line.pos);
  if (rest.startsWith('$$')) return { open: '$$', close: '$$' };
  if (rest.startsWith('\\[')) return { open: '\\[', close: '\\]' };
  return null;
}

function blockMath(cx: BlockContext, line: Line): boolean {
  const opener = blockOpener(line);
  if (!opener) return false;
  const from = cx.lineStart + line.pos;
  const first = line.text.slice(line.pos + opener.open.length);
  const same = first.indexOf(opener.close);
  if (same >= 0) {
    // One line: only when nothing but spaces follows the closer (else it is inline math in a paragraph).
    if (first.slice(same + opener.close.length).trim()) return false;
    cx.addElement(cx.elt('BlockMath', from, from + opener.open.length + same + opener.close.length));
    cx.nextLine();
    return true;
  }
  let to = cx.lineStart + line.text.length;
  while (cx.nextLine()) {
    // A blank line ends an unclosed formula: what came so far is shown, nothing after it is swallowed.
    if (!line.text.trim()) break;
    const at = line.text.indexOf(opener.close);
    if (at >= 0) {
      to = cx.lineStart + at + opener.close.length;
      cx.nextLine();
      break;
    }
    to = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt('BlockMath', from, to));
  return true;
}

export const MathExtension: MarkdownConfig = {
  defineNodes: [{ name: 'BlockMath', block: true }, 'InlineMath', 'DisplayMath'],
  parseBlock: [{
    name: 'BlockMath',
    before: 'FencedCode',
    parse: blockMath,
    endLeaf: (_cx, line) => blockOpener(line) !== null,
  }],
  parseInline: [{
    name: 'Math',
    before: 'Escape',
    parse(cx, next, pos) {
      if (next === BACKSLASH) {
        const after = cx.char(pos + 1);
        if (after === 40) return closed(cx, pos, 2, '\\)', 'InlineMath'); // \( … \)
        if (after === 91) return closed(cx, pos, 2, '\\]', 'DisplayMath'); // \[ … \]
        return -1;
      }
      if (next !== DOLLAR) return -1;
      if (cx.char(pos + 1) === DOLLAR) return closed(cx, pos, 2, '$$', 'DisplayMath');
      return singleDollar(cx, pos);
    },
  }],
};

/** GFM + math: the one parser every Markdown view in the app uses. */
export const markdownParser = baseParser.configure([GFM, MathExtension]);
export type SyntaxNode = ReturnType<typeof markdownParser.parse>['topNode'];

/** The TeX inside a math node's delimiters. */
export function mathSource(raw: string): string {
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']] as const) {
    if (raw.startsWith(open) && raw.endsWith(close) && raw.length >= open.length + close.length) {
      return raw.slice(open.length, raw.length - close.length).trim();
    }
  }
  return raw;
}
