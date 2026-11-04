import type { KbChartBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/**
 * chart: horizontal bars drawn with CSS (no chart library), labelled directly with their values.
 * The bars take the accent (R3); a variant bar is hatched — its pattern, not its colour, says so,
 * and a line under the bars names it.
 */
export function ChartBlock({ block }: { block: KbChartBlock }) {
  const max = Math.max(0, ...block.bars.map((b) => b.value));
  const unit = block.unit ? ` ${block.unit}` : '';
  return (
    <div className="kb-blk-chart">
      <ul className="kb-blk-chart__bars">
        {block.bars.map((bar) => {
          const width = max > 0 ? Math.max(bar.value > 0 ? 1 : 0, (bar.value / max) * 100) : 0;
          return (
            <BlockItem key={bar.id} item={bar} as="li" className="kb-blk-chart__bar">
              <span className="kb-blk-chart__label">{bar.label}</span>
              <span className="kb-blk-chart__track" aria-hidden="true">
                <span className={`kb-blk-chart__fill${bar.alt ? ' kb-blk-chart__fill--alt' : ''}`} style={{ width: `${width}%` }} />
              </span>
              <span className="kb-blk-chart__value">{bar.display}{unit}</span>
            </BlockItem>
          );
        })}
      </ul>
      {block.alt_label && (
        <div className="kb-blk-chart__note">
          <span className="kb-blk-chart__swatch" aria-hidden="true" />Hatched: {block.alt_label}
        </div>
      )}
    </div>
  );
}

export const chartItems = (block: KbChartBlock): BlockItemData[] => block.bars;
