import { PAGE_KIND_LABEL } from '../document/parts';
import { BUDGET_PAUSED_LABEL } from '../material/StatusChips';
import { CLAIM_LABEL, EDITED_LABEL } from '../wiki/blocks';

/** What the legend draws as the sample of a term (wiki/WikiLegend.tsx). */
export type WikiTermSample =
  | { type: 'page'; kind: 'note' | 'concept' | 'folder' | 'analysis' | 'deck' }
  | { type: 'claim'; kind: 'from_source' | 'explanation' | 'connection' | 'user_note'; edited?: true }
  | { type: 'source-number' }
  | { type: 'text' }
  | { type: 'recheck' }
  | { type: 'paused' };

export interface WikiTerm {
  id: string;
  /** The name exactly as the wiki shows it; what a screen reader hears for the sample. */
  name: string;
  /** One line: what it is and who writes it. */
  meaning: string;
  sample: WikiTermSample;
}

export interface WikiTermGroup {
  title: string;
  terms: ReadonlyArray<WikiTerm>;
}

/**
 * The wiki legend (wiki-terms v1, variant A, confirmed 2026-10-21): 15 labels the wiki shows, one line
 * each, opened by “?” on a wiki page, on the Wiki panel and by Settings → Wiki → Help → Wiki terms.
 * Names come from the product's own constants, so a renamed label is renamed here too. Settings rows
 * (Wiki model, budget, decisions, recognition check, find connections) explain themselves and are not repeated.
 */
export const WIKI_LEGEND: ReadonlyArray<WikiTermGroup> = [
  {
    title: 'Pages',
    terms: [
      { id: 'notes', name: PAGE_KIND_LABEL.note, meaning: 'What one material says. One page per material.', sample: { type: 'page', kind: 'note' } },
      { id: 'concept', name: PAGE_KIND_LABEL.concept, meaning: 'One idea, gathered from all your materials.', sample: { type: 'page', kind: 'concept' } },
      { id: 'folder', name: PAGE_KIND_LABEL.folder, meaning: 'Overview of a folder: topics, materials in order.', sample: { type: 'page', kind: 'folder' } },
      { id: 'analysis', name: PAGE_KIND_LABEL.analysis, meaning: 'A saved chat answer. Never cited as a source.', sample: { type: 'page', kind: 'analysis' } },
      { id: 'deck-test', name: `${PAGE_KIND_LABEL.deck} · ${PAGE_KIND_LABEL.test}`, meaning: 'Cards or a test made from your materials.', sample: { type: 'page', kind: 'deck' } },
    ],
  },
  {
    title: 'Statement labels',
    terms: [
      { id: 'from-source', name: CLAIM_LABEL.from_source, meaning: 'Said in a material, checked against the quote.', sample: { type: 'claim', kind: 'from_source' } },
      { id: 'explanation', name: CLAIM_LABEL.explanation, meaning: 'The agent’s own words, not a source. Editable.', sample: { type: 'claim', kind: 'explanation' } },
      { id: 'connection', name: CLAIM_LABEL.connection, meaning: 'A link the agent inferred. You can delete it.', sample: { type: 'claim', kind: 'connection' } },
      { id: 'my-note', name: CLAIM_LABEL.user_note, meaning: 'Yours. The agent never changes it.', sample: { type: 'claim', kind: 'user_note' } },
      { id: 'edited', name: EDITED_LABEL, meaning: 'An agent statement you changed.', sample: { type: 'claim', kind: 'explanation', edited: true } },
    ],
  },
  {
    title: 'On a page',
    terms: [
      { id: 'source-number', name: 'Source number', meaning: 'Click it for the exact quote and the place.', sample: { type: 'source-number' } },
      { id: 'related', name: 'Related · Mentioned in', meaning: 'Pages it links to · pages that link here.', sample: { type: 'text' } },
      { id: 'decide', name: 'Decide', meaning: 'Sources differ. You choose, not the agent.', sample: { type: 'text' } },
      { id: 'recheck', name: 'Re-check against sources', meaning: 'The agent rewrites it from its quotes.', sample: { type: 'recheck' } },
      { id: 'paused', name: BUDGET_PAUSED_LABEL, meaning: 'Budget used up. Continue resumes.', sample: { type: 'paused' } },
    ],
  },
];

/** Every name and meaning of the legend: Settings search finds the “Wiki terms” row by any of them. */
export const WIKI_TERMS_KEYWORDS = WIKI_LEGEND.flatMap((g) => g.terms.flatMap((t) => [t.name, t.meaning]))
  .concat('glossary legend labels help')
  .join(' ');
