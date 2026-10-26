import type { ComponentType } from 'react';
import { CompareBlock, compareItems } from './Compare';
import { StepsBlock, stepsItems } from './Steps';
import { TimelineBlock, timelineItems } from './Timeline';
import type { BlockData, BlockItemData } from './sources';

/**
 * The block renderers, one line per block type (the backend's `answer_blocks/registry.py` lists the
 * same names). A new block = one renderer module + one line here. `name` is the block's accessible
 * name only — R1: no visible type caption.
 */
interface Renderer<B extends BlockData> {
  name: string;
  View: ComponentType<{ block: B }>;
  /** Every drawn item, in reading order (their sources make the chip row). */
  items: (block: B) => BlockItemData[];
}

type Renderers = { [K in BlockData['kind']]: Renderer<Extract<BlockData, { kind: K }>> };

export const RENDERERS: Renderers = {
  compare: { name: 'Comparison', View: CompareBlock, items: compareItems },
  timeline: { name: 'Timeline', View: TimelineBlock, items: timelineItems },
  steps: { name: 'Steps', View: StepsBlock, items: stepsItems },
};

/** The renderer of `block`, typed to it. */
export function rendererOf<B extends BlockData>(block: B): Renderer<B> {
  return RENDERERS[block.kind] as unknown as Renderer<B>;
}
