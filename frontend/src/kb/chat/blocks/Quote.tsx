import type { KbQuoteBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** quote: the words as said; the quotation mark takes the accent (R3); the time is in the hover label (R2). */
export function QuoteBlock({ block }: { block: KbQuoteBlock }) {
  const { quote } = block;
  return (
    <BlockItem item={quote} className="kb-blk-qt">
      <span className="kb-blk-qt__mark" aria-hidden="true">“</span>
      <blockquote className="kb-blk-qt__text">{quote.text}</blockquote>
      {quote.who && <div className="kb-blk-qt__who">{quote.who}</div>}
    </BlockItem>
  );
}

export const quoteItems = (block: KbQuoteBlock): BlockItemData[] => [block.quote];
