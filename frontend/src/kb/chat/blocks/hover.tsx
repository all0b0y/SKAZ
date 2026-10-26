import { createContext, useContext, type ReactNode } from 'react';
import { Icon } from '../../ui';
import { itemKeys, itemTag, type BlockItemData, type BlockSource } from './sources';

/** Who is hovered in one block: an item (its chips light up) or a chip (its items light up). */
export type BlockHover = { from: 'item'; keys: readonly string[] } | { from: 'chip'; key: string } | null;

interface BlockScope {
  sources: readonly BlockSource[];
  hover: BlockHover;
  setHover: (hover: BlockHover) => void;
}

const Scope = createContext<BlockScope | null>(null);
export const BlockScopeProvider = Scope.Provider;

export function useBlockScope(): BlockScope {
  const scope = useContext(Scope);
  if (!scope) throw new Error('A block item is drawn outside its block');
  return scope;
}

type ItemTag = 'li' | 'td' | 'div';

/**
 * One item of a block. Its source is not marked in it (R2): hovering shows a small label above it
 * (source · time) and lights its chip in the row under the block. Neutral grey, never the accent
 * (R4: the accent is for P2's selection).
 */
export function BlockItem({ item, as: Tag = 'div', className, children }: {
  item: BlockItemData;
  as?: ItemTag;
  className?: string;
  children: ReactNode;
}) {
  const { sources, hover, setHover } = useBlockScope();
  const keys = itemKeys(item, sources);
  const tag = itemTag(item, sources);
  const lit = hover?.from === 'chip' && keys.includes(hover.key);
  return (
    <Tag className={`kb-blk__item${lit ? ' is-hl' : ''}${className ? ` ${className}` : ''}`} data-item-id={item.id}
      onMouseEnter={() => setHover({ from: 'item', keys })} onMouseLeave={() => setHover(null)}>
      {children}
      <span className={`kb-blk__tag${tag.agent ? ' kb-blk__tag--agent' : ''}`}>
        <Icon name={tag.icon} size={11} />{tag.text}
      </span>
    </Tag>
  );
}
