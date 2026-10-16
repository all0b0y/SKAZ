import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyToClipboard } from '../../lib/clipboard';
import type { KbQuote } from '../../api/kb/types.gen';
import { useServices } from '../state/context';
import { Icon } from './Icon';

/**
 * Shared text selection → "Ask / Add to question / Copy" (decision 21, item 3). Any element that
 * carries `quoteAttrs(...)` is quotable: an answer in chat, a wiki block, a material fragment (U3
 * marks its own). A selection that stays inside one such element becomes a quote token in the
 * message field (decision 23). A quote from chat is the AI's answer: context, never evidence.
 */
export type QuoteSource = Omit<KbQuote, 'text'>;

const MAX_QUOTE = 4000;

/** Data attributes that make an element quotable. */
export function quoteAttrs(q: QuoteSource): Record<string, string> {
  const out: Record<string, string> = { 'data-quote-source': q.source, 'data-quote-id': q.id };
  if (q.block_id) out['data-quote-block'] = q.block_id;
  if (q.seg !== undefined && q.seg !== null) out['data-quote-seg'] = String(q.seg);
  if (q.message_id) out['data-quote-message'] = q.message_id;
  return out;
}

function regionOf(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>('[data-quote-source]') ?? null;
}

/** The quote the current selection makes, or null (empty, or spanning two places). */
export function readSelectionQuote(selection: Selection | null): KbQuote | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const a = regionOf(selection.anchorNode);
  const b = regionOf(selection.focusNode);
  if (!a || a !== b) return null;
  const d = a.dataset;
  const source = d.quoteSource;
  if (source !== 'page' && source !== 'material' && source !== 'chat') return null;
  return {
    source,
    id: d.quoteId ?? '',
    block_id: d.quoteBlock ?? null,
    seg: d.quoteSeg !== undefined ? Number(d.quoteSeg) : null,
    message_id: d.quoteMessage ?? null,
    text: text.slice(0, MAX_QUOTE),
  };
}

export function SelectionToolbar() {
  const { composer } = useServices();
  const [state, setState] = useState<{ quote: KbQuote; left: number; top: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  const update = useCallback(() => {
    const selection = window.getSelection();
    const quote = readSelectionQuote(selection);
    if (!quote || !selection) { setState(null); return; }
    const range = selection.getRangeAt(0);
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : { left: 0, top: 0, width: 0, bottom: 0 };
    const width = 260;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    const top = rect.top > 48 ? rect.top - 40 : rect.bottom + 8;
    setState({ quote, left, top });
    setCopied(false);
  }, []);

  useEffect(() => {
    const onUp = (event: Event) => {
      if (barRef.current?.contains(event.target as Node)) return;
      // After the browser has settled the selection.
      window.setTimeout(update, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setState(null);
      else if (event.shiftKey || event.key.startsWith('Arrow')) window.setTimeout(update, 0);
    };
    const hide = () => setState(null);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onKey);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onKey);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [update]);

  if (!state) return null;
  const { quote } = state;
  const done = () => { window.getSelection()?.removeAllRanges(); setState(null); };
  return createPortal(
    <div ref={barRef} className="kb-selbar" role="toolbar" aria-label="Selected text" style={{ left: state.left, top: state.top }}
      onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="kb-selbar__btn" onClick={() => { composer.getState().push([{ kind: 'quote', quote }], { focus: true }); done(); }}>
        <Icon name="askAgent" size={14} />Ask
      </button>
      <button type="button" className="kb-selbar__btn" onClick={() => { composer.getState().push([{ kind: 'quote', quote }], { focus: false }); done(); }}>
        <Icon name="quote" size={14} />Add to question
      </button>
      <button type="button" className="kb-selbar__btn" onClick={async () => { setCopied(await copyToClipboard(quote.text)); }}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}
      </button>
    </div>,
    document.body,
  );
}
