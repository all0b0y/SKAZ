// Session groups are hashtags parsed out of the session title — there is no
// separate tags store, no localStorage, and no backend field for this. When
// the API grows a real `tags` field, only the input to parseTags/collectGroups
// changes; the parsing/coloring logic here stays put.
//
// Pure functions only: no React, no zustand. Keeps this trivially testable
// and reusable from both the rail chips and the search palette.

/** Matches #tag tokens: Unicode letters/digits plus - and _ inside the tag. */
const TAG_PATTERN = /#([\p{L}\p{N}_-]+)/gu;

const GROUP_COLOR_COUNT = 5;

/**
 * Extract the distinct hashtags in a session title, case-insensitively
 * deduplicated. The casing preserved for each tag is whichever spelling was
 * encountered first (`#Универ` then `#универ` keeps "Универ").
 */
export function parseTags(title: string): string[] {
  const firstSeenByKey = new Map<string, string>();
  for (const match of title.matchAll(TAG_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!firstSeenByKey.has(key)) firstSeenByKey.set(key, raw);
  }
  return [...firstSeenByKey.values()];
}

/**
 * Title with every #tag removed and whitespace collapsed. If stripping tags
 * would leave nothing (the title was made only of tags), the original title
 * is returned untouched — a session must never be shown with an empty name.
 */
export function stripTags(title: string): string {
  const stripped = title.replace(TAG_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > 0 ? stripped : title;
}

/**
 * Deterministic hash of a tag name into a small index (0..GROUP_COLOR_COUNT-1)
 * used to pick a muted palette entry (--group-1..--group-N in tokens.css).
 * Same tag always maps to the same color, independent of casing.
 */
export function tagColorIndex(tag: string): number {
  const key = tag.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % GROUP_COLOR_COUNT;
}

export interface TagGroup {
  /** Lowercase comparison key. */
  key: string;
  /** Display label using the first-seen casing across all sessions. */
  label: string;
  /** Number of sessions carrying this tag. */
  count: number;
  /** Index into the muted group-color palette (see tagColorIndex). */
  colorIndex: number;
}

export interface SessionForTags {
  title: string;
}

/**
 * Collect every group present across a list of sessions with counts, sorted
 * deterministically: highest count first, then alphabetically by key so the
 * chip row does not reorder itself as counts change ties.
 */
export function collectGroups(sessions: readonly SessionForTags[]): TagGroup[] {
  const byKey = new Map<string, { label: string; count: number }>();
  for (const session of sessions) {
    for (const tag of parseTags(session.title)) {
      const key = tag.toLowerCase();
      const existing = byKey.get(key);
      if (existing) existing.count += 1;
      else byKey.set(key, { label: tag, count: 1 });
    }
  }
  return [...byKey.entries()]
    .map(([key, { label, count }]) => ({ key, label, count, colorIndex: tagColorIndex(key) }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}

/** True if the session's title carries no #tag at all ("Ungrouped" bucket). */
export function isUngrouped(session: SessionForTags): boolean {
  return parseTags(session.title).length === 0;
}
