import { useRef } from 'react';
import type { KbCompareBlock } from '../../../api/kb/types.gen';
import { useAnswerId } from '../select/context';
import { MIN_COLUMN_WIDTH, useColumnWidths } from './columnWidths';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** compare: the things side by side (columns) on the same criteria (rows). */
export function CompareBlock({ block, blockId }: { block: KbCompareBlock; blockId: string }) {
  const table = useRef<HTMLTableElement | null>(null);
  const messageId = useAnswerId();
  const labels = ['Criterion', ...block.columns];
  const { widths, handle } = useColumnWidths(`${messageId ?? ''}:${blockId}`, labels.length, table);
  const grip = (index: number) => <button type="button" className="kb-blk-cmp__resize" {...handle(index)}
    aria-label={`Resize ${labels[index]} column`}
    title="Drag or use arrow keys to resize. Double-click to reset this table." />;
  return (
    <div className="kb-blk-cmp__wrap">
      <table ref={table} className="kb-blk-cmp" style={{ minWidth: labels.length * MIN_COLUMN_WIDTH,
        ...(widths ? { width: widths.reduce((sum, n) => sum + n, 0) } : {}) }}>
        <colgroup>{labels.map((_, i) => <col key={i} style={widths ? { width: widths[i] } : undefined} />)}</colgroup>
        <thead>
          <tr><th scope="col" aria-label="Criterion">{grip(0)}</th>{block.columns.map((column, i) => (
            <th key={i} scope="col" aria-label={column}>{column}{grip(i + 1)}</th>))}</tr>
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
