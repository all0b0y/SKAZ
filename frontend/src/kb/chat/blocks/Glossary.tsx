import type { KbGlossaryBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** glossary: terms and their meaning, one row each (term column, meaning column). */
export function GlossaryBlock({ block }: { block: KbGlossaryBlock }) {
  return (
    <ul className="kb-blk-gl">
      {block.terms.map((term) => (
        <BlockItem key={term.id} item={term} as="li">
          <dfn className="kb-blk-gl__term">{term.term}</dfn>
          <span className="kb-blk-gl__text">{term.text}</span>
        </BlockItem>
      ))}
    </ul>
  );
}

export const glossaryItems = (block: KbGlossaryBlock): BlockItemData[] => block.terms;
