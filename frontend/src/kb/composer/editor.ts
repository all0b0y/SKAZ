// The message field's editing model: a contenteditable box with atomic tokens for @-mentions and
// quotes (decision 23: quotes are tokens inside the text, like mentions; full text on hover; the
// field grows like text and scrolls after five lines). Pure DOM helpers, tested in jsdom.

import type { KbQuote, KbRef } from '../../api/kb/types.gen';

export type Token = { kind: 'mention'; ref: KbRef } | { kind: 'quote'; quote: KbQuote };

export interface EditorValue {
  text: string;
  mentions: KbRef[];
  quotes: KbQuote[];
}

const QUOTE_LABEL = 28;

/** Short visible text of a quote token; the full text is in its tooltip. */
export function quoteLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= QUOTE_LABEL) return flat;
  // Cut at a word boundary when there is one near the end.
  const head = flat.slice(0, QUOTE_LABEL);
  const space = head.lastIndexOf(' ');
  return `${(space > QUOTE_LABEL / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** What a token stands for inside the message text sent to the agent. */
export function tokenText(token: Token): string {
  return token.kind === 'mention' ? `@${token.ref.title}` : `“${quoteLabel(token.quote.text)}”`;
}

function iconFor(token: Token): string {
  if (token.kind === 'quote') return 'quote';
  if (token.ref.type === 'chat') return 'chat';
  if (token.ref.type === 'material') return 'material';
  return 'page';
}

export function tokenElement(token: Token, doc: Document = document): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = `kb-token kb-token--${token.kind}`;
  span.setAttribute('contenteditable', 'false');
  span.dataset.token = JSON.stringify(token);
  span.dataset.icon = iconFor(token);
  if (token.kind === 'quote') {
    const from = token.quote.source === 'chat' ? 'AI answer (context, not a source)' : 'Quote';
    span.setAttribute('aria-label', `${from}: ${token.quote.text}`);
    span.dataset.full = token.quote.text;
    span.textContent = quoteLabel(token.quote.text);
  } else {
    span.setAttribute('aria-label', `Reference: ${token.ref.title}`);
    span.textContent = token.ref.title;
  }
  return span;
}

function readToken(el: HTMLElement): Token | null {
  try {
    return JSON.parse(el.dataset.token ?? '') as Token;
  } catch {
    return null;
  }
}

const BLOCKS = new Set(['DIV', 'P']);

/** Text (tokens written as `@Title` / `“quote…”`) and the referenced items, in order, deduplicated. */
export function serialize(root: HTMLElement): EditorValue {
  let text = '';
  const mentions: KbRef[] = [];
  const quotes: KbQuote[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child.nodeValue ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
      } else if (child instanceof HTMLElement) {
        if (child.dataset.token) {
          const token = readToken(child);
          if (!token) continue;
          text += tokenText(token);
          if (token.kind === 'mention' && !mentions.some((m) => m.type === token.ref.type && m.id === token.ref.id)) mentions.push(token.ref);
          if (token.kind === 'quote') quotes.push(token.quote);
        } else if (child.tagName === 'BR') {
          text += '\n';
        } else {
          if (BLOCKS.has(child.tagName) && text && !text.endsWith('\n')) text += '\n';
          walk(child);
        }
      }
    }
  };
  walk(root);
  return { text: text.replace(/\n+$/, ''), mentions, quotes };
}

export function isEmpty(root: HTMLElement): boolean {
  const v = serialize(root);
  return !v.text.trim() && v.mentions.length === 0 && v.quotes.length === 0;
}

export interface MentionMatch {
  node: Text;
  start: number;
  end: number;
  query: string;
}

/** The `@query` right before the caret, if the caret is in this editor's text. */
export function mentionAtCaret(root: HTMLElement, selection: Selection | null = window.getSelection()): MentionMatch | null {
  if (!selection || !selection.isCollapsed || !selection.anchorNode) return null;
  const node = selection.anchorNode;
  if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const before = (node.nodeValue ?? '').slice(0, selection.anchorOffset);
  // The query may have several words (QA D8: "@B5 qual"), single spaces between them, up to 40
  // characters; a double space or a line break ends it.
  const match = /(^|[\s(\u00a0])@((?:[^\s@]+[ \u00a0]?){0,8})$/.exec(before);
  if (!match || match[2]!.length > 40) return null;
  const start = before.length - match[2]!.length - 1;
  return { node: node as Text, start, end: selection.anchorOffset, query: match[2]!.replace(/\u00a0/g, ' ') };
}

function placeCaretAfter(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A range at the caret if it is inside `root`, else at the end of `root`. */
function caretRange(root: HTMLElement): Range {
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const r = selection.getRangeAt(0);
    if (root.contains(r.startContainer)) return r;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/** Insert a token (replacing an `@query` when given) followed by a space; the caret goes after it. */
export function insertToken(root: HTMLElement, token: Token, replace?: MentionMatch | null): void {
  const el = tokenElement(token);
  const space = document.createTextNode('\u00a0');
  if (replace && root.contains(replace.node)) {
    const range = document.createRange();
    range.setStart(replace.node, replace.start);
    range.setEnd(replace.node, replace.end);
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(el);
  } else {
    const range = caretRange(root);
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(el);
  }
  placeCaretAfter(space);
}

/** Insert plain text at the caret (dictation, a pasted question). */
export function insertText(root: HTMLElement, value: string): void {
  if (!value) return;
  const range = caretRange(root);
  range.deleteContents();
  const before = range.startContainer.nodeType === Node.TEXT_NODE
    ? (range.startContainer.nodeValue ?? '').slice(0, range.startOffset) : root.textContent ?? '';
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const node = document.createTextNode(`${lead}${value}`);
  range.insertNode(node);
  placeCaretAfter(node);
}

export function clearEditor(root: HTMLElement): void {
  root.replaceChildren();
}
