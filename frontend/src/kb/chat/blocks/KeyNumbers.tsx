import type { KbKeyNumbersBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** key_numbers: a few numbers, large (the accent, R3), each with what it measures. */
export function KeyNumbersBlock({ block }: { block: KbKeyNumbersBlock }) {
  return (
    <ul className="kb-blk-kn">
      {block.numbers.map((n) => (
        <BlockItem key={n.id} item={n} as="li" className="kb-blk-kn__tile">
          <div className="kb-blk-kn__value">{n.value}{n.unit && <small>{n.unit}</small>}</div>
          <div className="kb-blk-kn__label">{n.label}</div>
        </BlockItem>
      ))}
    </ul>
  );
}

export const keyNumbersItems = (block: KbKeyNumbersBlock): BlockItemData[] => block.numbers;
