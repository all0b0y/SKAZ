import type { KbCompareBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** compare: the things side by side (columns) on the same criteria (rows). */
export function CompareBlock({ block }: { block: KbCompareBlock }) {
  return (
    <div className="kb-blk-cmp__wrap">
      <table className="kb-blk-cmp">
        <thead>
          <tr><td />{block.columns.map((column, i) => <th key={i} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.id} data-item-id={row.id}>
              <th scope="row">{row.label}</th>
              {row.cells.map((cell, i) => (cell
                ? <BlockItem key={cell.id} item={cell} as="td">{cell.text}</BlockItem>
                // A hidden cell: its data was invalid or its source wasn't found (the badge counts it).
                : <td key={`hidden-${i}`} className="kb-blk-cmp__none" aria-label="Hidden">—</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const compareItems = (block: KbCompareBlock): BlockItemData[] =>
  block.rows.flatMap((row) => row.cells.filter((cell): cell is NonNullable<typeof cell> => cell !== null));
