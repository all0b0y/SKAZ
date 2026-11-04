import type { KbDisagreementBlock } from '../../../api/kb/types.gen';
import { Icon } from '../../ui';
import { BlockItem, useBlockScope } from './hover';
import { itemTag, type BlockItemData } from './sources';

/** disagreement: what each source says, side by side on equal terms, and what they agree on. */
export function DisagreementBlock({ block }: { block: KbDisagreementBlock }) {
  const { sources } = useBlockScope();
  return (
    <div className="kb-blk-dis">
      <div className="kb-blk-dis__sides">
        {block.sides.map((side) => {
          const who = itemTag(side, sources);
          return (
            <BlockItem key={side.id} item={side} className="kb-blk-dis__side">
              <div className="kb-blk-dis__src"><Icon name={who.icon} size={12} />{who.text}</div>
              {side.text}
            </BlockItem>
          );
        })}
      </div>
      {block.agree && (
        <BlockItem item={block.agree} className="kb-blk-dis__agree">
          <Icon name="check" size={13} />
          <span><b>They agree:</b> {block.agree.text}</span>
        </BlockItem>
      )}
    </div>
  );
}

export const disagreementItems = (block: KbDisagreementBlock): BlockItemData[] =>
  block.agree ? [...block.sides, block.agree] : block.sides;
