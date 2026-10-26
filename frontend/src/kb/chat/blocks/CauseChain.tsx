import { Fragment } from 'react';
import type { KbCauseChainBlock } from '../../../api/kb/types.gen';
import { ArrowRight } from './glyphs';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** cause_chain: each link leads to the next — the arrows carry the order (the accent, R3). */
export function CauseChainBlock({ block }: { block: KbCauseChainBlock }) {
  return (
    <ol className="kb-blk-chain">
      {block.nodes.map((node, i) => (
        <Fragment key={node.id}>
          {i > 0 && <li className="kb-blk-chain__arr" aria-hidden="true"><ArrowRight /></li>}
          <BlockItem item={node} as="li" className="kb-blk-chain__node">
            {node.label && <small className="kb-blk-chain__label">{node.label}</small>}
            {node.text}
          </BlockItem>
        </Fragment>
      ))}
    </ol>
  );
}

export const causeChainItems = (block: KbCauseChainBlock): BlockItemData[] => block.nodes;
