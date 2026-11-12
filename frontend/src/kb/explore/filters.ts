// EX3 (UX-5): the filters of a search page — Free only, Year, Type, Show — and its Sort. The choice is
// remembered on this computer and applies to every search.

import type { SearchFindingsQuery } from '../api/explore';

export type YearFilter = 'any' | '1y' | '3y' | { from: number; to: number };
export type TypeFilter = 'any' | 'preprint' | 'peer_reviewed' | 'review' | 'other';
export type ShowFilter = NonNullable<SearchFindingsQuery['show']>;
export type SortOrder = NonNullable<SearchFindingsQuery['sort']>;

export interface FindingFilters {
  free: boolean;
  year: YearFilter;
  type: TypeFilter;
  show: ShowFilter;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: FindingFilters = { free: true, year: 'any', type: 'any', show: 'active', sort: 'for_you' };

const KEY = 'skaz.explore.filters';

function validYear(raw: unknown): YearFilter {
  if (raw === '1y' || raw === '3y' || raw === 'any') return raw;
  if (raw && typeof raw === 'object') {
    const r = raw as { from?: unknown; to?: unknown };
    if (Number.isInteger(r.from) && Number.isInteger(r.to)) return { from: r.from as number, to: r.to as number };
  }
  return 'any';
}

export function readFilters(storage: Pick<Storage, 'getItem'> | null = safeStorage()): FindingFilters {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<Record<keyof FindingFilters, unknown>>;
    return {
      free: typeof raw.free === 'boolean' ? raw.free : DEFAULT_FILTERS.free,
      year: validYear(raw.year),
      type: (['any', 'preprint', 'peer_reviewed', 'review', 'other'] as const).find((t) => t === raw.type) ?? 'any',
      show: (['active', 'new', 'seen', 'dismissed'] as const).find((t) => t === raw.show) ?? 'active',
      sort: (['for_you', 'newest', 'cited'] as const).find((t) => t === raw.sort) ?? 'for_you',
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function writeFilters(filters: FindingFilters, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(KEY, JSON.stringify(filters)); } catch { /* a full or blocked storage only forgets the choice */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** The query of one search page under these filters. `today` decides «last 12 months / 3 years». */
export function filtersQuery(runId: string, f: FindingFilters, today = new Date()): SearchFindingsQuery {
  const year = today.getFullYear();
  const range = f.year === '1y' ? { year_from: year - 1 } : f.year === '3y' ? { year_from: year - 3 }
    : f.year === 'any' ? {} : { year_from: f.year.from, year_to: f.year.to };
  return {
    run_id: runId,
    show: f.show,
    free_only: f.free,
    sort: f.sort,
    ...range,
    ...(f.type === 'any' ? {} : { types: [f.type] }),
    limit: 100,
  };
}

export const YEAR_LABEL = (y: YearFilter): string =>
  y === 'any' ? 'Year' : y === '1y' ? 'Last 12 months' : y === '3y' ? 'Last 3 years' : `${y.from}–${y.to}`;
export const TYPE_LABEL: Record<TypeFilter, string> = {
  any: 'Type', preprint: 'Preprints', peer_reviewed: 'Peer-reviewed', review: 'Reviews', other: 'Other types',
};
export const SHOW_LABEL: Record<ShowFilter, string> = {
  active: 'New & seen', new: 'New', seen: 'Seen', dismissed: 'Not for me',
};
export const SORT_LABEL: Record<SortOrder, string> = {
  for_you: 'For you first', newest: 'Newest first', cited: 'Most cited',
};

export function filtersActive(f: FindingFilters): boolean {
  return f.year !== 'any' || f.type !== 'any' || f.show !== 'active';
}
