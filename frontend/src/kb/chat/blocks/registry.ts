import type { ComponentType } from 'react';
import { ActionItemsBlock, actionItemsItems } from './ActionItems';
import { CauseChainBlock, causeChainItems } from './CauseChain';
import { ChartBlock, chartItems } from './Chart';
import { CompareBlock, compareItems } from './Compare';
import { ConceptCardsBlock, conceptCardsItems } from './ConceptCards';
import { DefinitionBlock, definitionItems } from './Definition';
import { DisagreementBlock, disagreementItems } from './Disagreement';
import { GlossaryBlock, glossaryItems } from './Glossary';
import { HierarchyBlock, hierarchyItems } from './Hierarchy';
import { KeyNumbersBlock, keyNumbersItems } from './KeyNumbers';
import { ProsConsBlock, prosConsItems } from './ProsCons';
import { QuoteBlock, quoteItems } from './Quote';
import { StepsBlock, stepsItems } from './Steps';
import { TimelineBlock, timelineItems } from './Timeline';
import { VerdictBlock, verdictItems } from './Verdict';
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
  pros_cons: { name: 'Pros and cons', View: ProsConsBlock, items: prosConsItems },
  verdict: { name: 'Verdict', View: VerdictBlock, items: verdictItems },
  timeline: { name: 'Timeline', View: TimelineBlock, items: timelineItems },
  steps: { name: 'Steps', View: StepsBlock, items: stepsItems },
  cause_chain: { name: 'Cause chain', View: CauseChainBlock, items: causeChainItems },
  definition: { name: 'Definition', View: DefinitionBlock, items: definitionItems },
  concept_cards: { name: 'Concepts', View: ConceptCardsBlock, items: conceptCardsItems },
  hierarchy: { name: 'Hierarchy', View: HierarchyBlock, items: hierarchyItems },
  glossary: { name: 'Glossary', View: GlossaryBlock, items: glossaryItems },
  key_numbers: { name: 'Key numbers', View: KeyNumbersBlock, items: keyNumbersItems },
  chart: { name: 'Chart', View: ChartBlock, items: chartItems },
  quote: { name: 'Quote', View: QuoteBlock, items: quoteItems },
  disagreement: { name: 'Sources disagree', View: DisagreementBlock, items: disagreementItems },
  action_items: { name: 'Action items', View: ActionItemsBlock, items: actionItemsItems },
};

/** The renderer of `block`, typed to it. */
export function rendererOf<B extends BlockData>(block: B): Renderer<B> {
  return RENDERERS[block.kind] as unknown as Renderer<B>;
}
