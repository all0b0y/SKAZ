import type { KbDefinitionBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** definition: the term (the accent, R3), its other names, what it means and an example. */
export function DefinitionBlock({ block }: { block: KbDefinitionBlock }) {
  return (
    <div className="kb-blk-def">
      <div>
        <dfn className="kb-blk-def__term">{block.term}</dfn>
        {block.also.length > 0 && <span className="kb-blk-def__also">{block.also.join(' · ')}</span>}
      </div>
      <BlockItem item={block.definition} className="kb-blk-def__text">{block.definition.text}</BlockItem>
      {block.example && (
        <BlockItem item={block.example} className="kb-blk-def__ex">
          <small>Example</small>{block.example.text}
        </BlockItem>
      )}
    </div>
  );
}

export const definitionItems = (block: KbDefinitionBlock): BlockItemData[] =>
  block.example ? [block.definition, block.example] : [block.definition];
