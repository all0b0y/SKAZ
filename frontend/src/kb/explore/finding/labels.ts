// Wording and the small rules of the finding view (N4 v4 states 09–14). Pure: no client, no store.
import type { KbFinding, KbPaidAccess, KbScienceSettings, KbScienceWork } from '../../../api/kb/types.gen';

export type FindingLabel = KbFinding['label'];
export type ReadMarkValue = NonNullable<KbFinding['read_mark']>;
export type ExploreMode = 'brief_tour' | 'deep_dive' | 'notes';
export type AddContent = 'full_text' | 'abstract_only';

export const LABEL_TEXT: Record<FindingLabel, string> = {
  new: 'New',
  extends: 'Extends your wiki',
  contradicts: 'Contradicts your wiki',
  branch: 'Branch from your wiki',
  covered: 'Already in your wiki',
};

export const READ_MARKS: readonly ReadMarkValue[] = ['useful_method', 'changed_my_view', 'already_knew', 'not_for_me'];

export const READ_MARK_TEXT: Record<ReadMarkValue, string> = {
  useful_method: 'Useful method',
  changed_my_view: 'Changed my view',
  already_knew: 'Already knew this',
  not_for_me: 'Not for me',
};

export const EXPLORE_MODES: ReadonlyArray<{ mode: ExploreMode; label: string }> = [
  { mode: 'brief_tour', label: 'Brief tour' },
  { mode: 'deep_dive', label: 'Deep dive' },
  { mode: 'notes', label: 'Notes' },
];

export const MODE_LABEL: Record<ExploreMode, string> = {
  brief_tour: 'Brief tour',
  deep_dive: 'Deep dive',
  notes: 'Notes',
};

/** The approved paid copy. The "…" is where the server's reason goes when it sends no recommendation. */
export const PAID_COPY = "This article is paid. I think it's useful because … You can check it yourself; if you get it, add it to your materials.";

export const OPENALEX_HINT = 'Add a free OpenAlex key to get full text for articles like this one.';

export function authorLine(work: KbScienceWork): string {
  const first = work.authors[0];
  if (!first) return '';
  return work.authors.length > 1 ? `${first} et al.` : first;
}

export function sourceLine(text: KbFinding['text_available']): string {
  if (text === 'full_text') return 'Full text';
  if (text === 'abstract_only') return 'Abstract only · full text is PDF or paywalled';
  return 'Full text not checked yet';
}

/** The publisher's page: the access record's first, else a publisher location. Never a "buy" target. */
export function publisherUrl(work: KbScienceWork): string | null {
  return work.access.publisher_url ?? work.locations.find((l) => l.kind === 'publisher')?.url ?? null;
}

export function paidText(access: KbPaidAccess): string {
  return access.recommendation ?? PAID_COPY;
}

/** Full text when there is one; otherwise the abstract, honestly labelled (an unchecked text is not claimed). */
export function addContent(finding: KbFinding): AddContent {
  return finding.text_available === 'full_text' ? 'full_text' : 'abstract_only';
}

export function addLabel(content: AddContent): string {
  return content === 'full_text' ? 'Add to wiki · full text' : 'Add to wiki · abstract only';
}

/** Paid articles are not added from here (the copy says: if you get it, add it to your materials). */
export function showsAddToWiki(finding: KbFinding): boolean {
  return !finding.work.access.paid && finding.material_id === null;
}

/** The one-time hint: an abstract, no key, not dismissed. Unknown settings show nothing. */
export function hintShown(finding: KbFinding, settings: KbScienceSettings | null): boolean {
  return settings !== null && finding.text_available === 'abstract_only'
    && !settings.openalex_key_configured && !settings.full_text_hint_dismissed;
}
