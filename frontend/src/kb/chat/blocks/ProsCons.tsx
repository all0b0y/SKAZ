import type { KbProsConsBlock } from '../../../api/kb/types.gen';
import { Icon } from '../../ui';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** pros_cons: arguments for (+) and against (−); the shape of the mark says which, not only its colour. */
export function ProsConsBlock({ block }: { block: KbProsConsBlock }) {
  const points = [...block.pros.map((p) => ({ p, pro: true })), ...block.cons.map((p) => ({ p, pro: false }))];
  return (
    <ul className="kb-blk-pc">
      {points.map(({ p, pro }) => (
        <BlockItem key={p.id} item={p} as="li">
          <span className={`kb-blk-pc__mark kb-blk-pc__mark--${pro ? 'pro' : 'con'}`} role="img" aria-label={pro ? 'For' : 'Against'}>
            <Icon name={pro ? 'plus' : 'minus'} size={11} />
          </span>
          <span className="kb-blk-pc__text">{p.text}</span>
        </BlockItem>
      ))}
    </ul>
  );
}

export const prosConsItems = (block: KbProsConsBlock): BlockItemData[] => [...block.pros, ...block.cons];
