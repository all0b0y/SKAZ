import type { KbAnswerBlockPart, KbCitation } from '../../../api/kb/types.gen';
import type { IconName } from '../../ui';
import { clock } from '../../ui/time';

/**
 * P1 R2: the sources of an answer block. Items carry no marks; one row of source chips sits under
 * the block — one chip per recording/document, wiki page or web result (and a dashed «Agent's
 * knowledge» chip when such items exist). Hovering an item names its source above it and lights
 * its chip; hovering a chip lights the items that rest on it.
 */

export type BlockData = NonNullable<KbAnswerBlockPart['block']>;
export type BlockSource = KbAnswerBlockPart['sources'][number];

/** What every drawn item has (the backend's `KbBlockItem`). */
export interface BlockItemData {
  id: string;
  /** Indexes into the part's `sources`. */
  src: number[];
  agent: boolean;
}

export const AGENT_KEY = 'agent';

/** One chip per source: segments of one material share their material's chip. */
export function sourceKey(source: BlockSource): string {
  if (source.type === 'cite') return `m:${source.citation.material_id}`;
  if (source.type === 'page') return `p:${source.page.id}`;
  return `w:${source.url}`;
}

export interface BlockChip {
  key: string;
  label: string;
  icon: IconName;
  /** False when the material or page is gone: the chip says so and opens nothing. */
  available: boolean;
  /** What a click opens (the first source of this chip, in item order); null for the agent chip. */
  source: BlockSource | null;
}

function sourceLabel(source: BlockSource): string {
  if (source.type === 'cite') return source.citation.material_title ?? 'Source';
  if (source.type === 'page') return source.page.title;
  return source.site || source.title || source.url;
}

function sourceIcon(source: BlockSource): IconName {
  if (source.type === 'cite') return source.citation.start_ms !== null ? 'play' : 'pdf';
  if (source.type === 'page') return 'concept';
  return 'web';
}

/** Where in the source: the recording time, the document page, the paragraph. */
export function sourceMeta(source: BlockSource): string | null {
  if (source.type !== 'cite') return null;
  const c = source.citation;
  if (c.start_ms !== null) return clock(c.start_ms);
  if (c.page !== null) return `p. ${c.page}`;
  if (c.index !== null && c.index !== undefined) return `¶ ${c.index}`;
  return null;
}

function available(source: BlockSource): boolean {
  if (source.type === 'cite') return source.citation.available;
  if (source.type === 'page') return source.available;
  return true;
}

/** The chip keys an item rests on (its own knowledge: the agent chip). */
export function itemKeys(item: BlockItemData, sources: readonly BlockSource[]): string[] {
  if (item.agent) return [AGENT_KEY];
  const keys: string[] = [];
  for (const index of item.src) {
    const source = sources[index];
    if (!source) continue;
    const key = sourceKey(source);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The row under the block, in the order the items first cite them; the agent chip last. */
export function blockChips(sources: readonly BlockSource[], items: readonly BlockItemData[]): BlockChip[] {
  const chips: BlockChip[] = [];
  let agent = false;
  for (const item of items) {
    if (item.agent) { agent = true; continue; }
    for (const index of item.src) {
      const source = sources[index];
      if (!source) continue;
      const key = sourceKey(source);
      if (chips.some((c) => c.key === key)) continue;
      chips.push({ key, label: sourceLabel(source), icon: sourceIcon(source), available: available(source), source });
    }
  }
  if (agent) chips.push({ key: AGENT_KEY, label: 'Agent’s knowledge', icon: 'agent', available: true, source: null });
  return chips;
}

/** The label shown above a hovered item: its source(s), with the time or page of the first one. */
export function itemTag(item: BlockItemData, sources: readonly BlockSource[]): { text: string; icon: IconName; agent: boolean } {
  if (item.agent) return { text: 'Agent’s knowledge', icon: 'agent', agent: true };
  const own = item.src.map((i) => sources[i]).filter((s): s is BlockSource => !!s);
  const labels = [...new Set(own.map(sourceLabel))];
  const first = own[0];
  const meta = first ? sourceMeta(first) : null;
  return { text: `${labels.join(', ')}${meta ? ` · ${meta}` : ''}`, icon: first ? sourceIcon(first) : 'pdf', agent: false };
}

/** A timeline event without a date sits at the start of its first source: a recording fragment. */
export function timecode(item: BlockItemData, sources: readonly BlockSource[]): { ms: number; citation: KbCitation } | null {
  const source = sources[item.src[0] ?? -1];
  if (!source || source.type !== 'cite' || source.citation.start_ms === null) return null;
  return { ms: source.citation.start_ms, citation: source.citation };
}
