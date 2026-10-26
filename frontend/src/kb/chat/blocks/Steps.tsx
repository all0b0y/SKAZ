import type { KbStepsBlock } from '../../../api/kb/types.gen';
import { BlockItem } from './hover';
import type { BlockItemData } from './sources';

/** steps: an ordered procedure; the numbers carry the order (the accent, R3). */
export function StepsBlock({ block }: { block: KbStepsBlock }) {
  return (
    <ol className="kb-blk-steps">
      {block.steps.map((step) => (
        <BlockItem key={step.id} item={step} as="li">
          <span className="kb-blk-steps__body">
            <b>{step.title}</b>
            {step.text && <span className="kb-blk-steps__text">{step.text}</span>}
          </span>
        </BlockItem>
      ))}
    </ol>
  );
}

export const stepsItems = (block: KbStepsBlock): BlockItemData[] => block.steps;
