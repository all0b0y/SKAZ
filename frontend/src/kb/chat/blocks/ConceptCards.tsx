import type { KbConceptCardsBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** concept_cards: one small card per concept; the accent line on top (R3). */
export function ConceptCardsBlock({ block }: { block: KbConceptCardsBlock }) {
  return (
    <ul className="kb-blk-cards">
      {block.cards.map((card) => (
        <BlockItem key={card.id} item={card} as="li" className="kb-blk-cards__card">
          <div className="kb-blk-cards__name">{card.name}</div>
          <div className="kb-blk-cards__text">{card.text}</div>
        </BlockItem>
      ))}
    </ul>
  );
}

export const conceptCardsItems = (block: KbConceptCardsBlock): BlockItemData[] => block.cards;
