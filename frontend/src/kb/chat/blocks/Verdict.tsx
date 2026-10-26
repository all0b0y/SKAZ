import type { KbVerdictBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** verdict: the conclusion, marked by the accent bar (R3), and why. */
export function VerdictBlock({ block }: { block: KbVerdictBlock }) {
  const { verdict } = block;
  return (
    <div className="kb-blk-verdict">
      <span className="kb-blk-verdict__bar" aria-hidden="true" />
      <BlockItem item={verdict} className="kb-blk-verdict__main">
        <div className="kb-blk-verdict__text">{verdict.text}</div>
        {verdict.reason && <div className="kb-blk-verdict__reason">{verdict.reason}</div>}
      </BlockItem>
    </div>
  );
}

export const verdictItems = (block: KbVerdictBlock): BlockItemData[] => [block.verdict];
