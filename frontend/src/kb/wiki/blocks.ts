import type { KbBlock } from '../../api/kb/types.gen';
import type { IconName } from '../ui';

export type ClaimKind = KbBlock['kind'];

/** The four kinds of statements (decisions 20–22): a label with its own shape, never colour alone. */
export const CLAIM_LABEL: Record<ClaimKind, string> = {
  from_source: 'From sources',
  connection: 'Connection — agent inference',
  explanation: 'Agent explanation',
  user_note: 'My note',
};

/** The label of an agent statement the user changed (it is theirs now). */
export const EDITED_LABEL = 'Edited by you';

export const CLAIM_ICON: Record<ClaimKind, IconName> = {
  from_source: 'quote',
  connection: 'graph',
  explanation: 'models',
  user_note: 'pencil',
};

/** Section headings the wiki writes for each kind (wiki language en/ru, backend markdown/page.py). */
const STANDARD_TITLES: Record<ClaimKind, readonly string[]> = {
  from_source: ['From sources', 'Из источников'],
  connection: ['Connections (agent inference)', 'Связи (вывод агента)'],
  explanation: ['Agent explanation', 'Пояснение агента'],
  user_note: ['My notes', 'Мои заметки'],
};

/** The heading already names the kind: the section shows no second label of the same words (QA C10). */
export function namesItsKind(section: Pick<PageSection, 'title' | 'kind'>): boolean {
  return !!section.kind && !!section.title && STANDARD_TITLES[section.kind].includes(section.title);
}

/**
 * Code-written navigation of a page ("In folders", "Related", "Key concepts", "Materials in
 * order"): lists of links, not an agent's inference — no statement label, no ✎ (QA C10).
 */
const NAVIGATION_IDS = new Set(['c-in-folders', 'c-related', 'c-concepts', 'c-ov-concepts', 'c-ov-materials']);
export function isNavigation(block: Pick<KbBlock, 'id' | 'owner'>): boolean {
  return NAVIGATION_IDS.has(block.id) && block.owner === 'agent';
}

export interface PageSection {
  key: string;
  /** Section heading as written in the page; null = the page's opening blocks. */
  title: string | null;
  /** The kind every block of the section shares, if any: the section carries the label then. */
  kind: ClaimKind | null;
  blocks: KbBlock[];
}

/** Consecutive blocks with the same `section` form one section, in page order. */
export function groupSections(blocks: readonly KbBlock[]): PageSection[] {
  const out: PageSection[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && last.title === block.section) {
      last.blocks.push(block);
      continue;
    }
    out.push({ key: `${out.length}:${block.section ?? ''}`, title: block.section, kind: null, blocks: [block] });
  }
  for (const section of out) {
    const kinds = new Set(section.blocks.map((b) => b.kind));
    section.kind = kinds.size === 1 && !section.blocks.every(isNavigation) ? section.blocks[0]!.kind : null;
  }
  return out;
}

/** Agent inference/explanation, the user's own notes and anything already edited can be edited. */
export function canEdit(block: KbBlock): boolean {
  if (isNavigation(block)) return false;
  return block.kind !== 'from_source' || block.owner !== 'agent';
}

/**
 * A connection SKAZ wrote between two concepts (`c-link-*`, edited or not): the backend lets it be
 * deleted and never suggests the pair again (wiki/edit.py `is_connection`). Other agent blocks stay.
 */
export function isSkazConnection(block: Pick<KbBlock, 'id' | 'kind'>): boolean {
  return block.kind === 'connection' && block.id.startsWith('c-link-');
}

export function isEditedByUser(block: KbBlock): boolean {
  return block.owner === 'user_edited';
}
