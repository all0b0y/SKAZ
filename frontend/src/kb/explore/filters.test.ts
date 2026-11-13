import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FILTERS, SHOW_LABEL, SORT_LABEL, TYPE_LABEL, YEAR_LABEL, filtersActive, filtersQuery, readFilters, writeFilters,
  type FindingFilters,
} from './filters';

/** A Storage that is only a map, so a test controls exactly what was saved. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

describe('EX3 filters (UX-5) — remembered choice', () => {
  it('starts with Free only on, any year, any type, New & seen, For you first', () => {
    expect(readFilters(memory())).toEqual(DEFAULT_FILTERS);
    expect(DEFAULT_FILTERS).toEqual({ free: true, year: 'any', type: 'any', show: 'active', sort: 'for_you' });
  });

  it('writes the choice and reads it back, including a year range', () => {
    const store = memory();
    const chosen: FindingFilters = { free: false, year: { from: 2022, to: 2024 }, type: 'peer_reviewed', show: 'dismissed', sort: 'cited' };
    writeFilters(chosen, store);
    expect(readFilters(store)).toEqual(chosen);
    writeFilters({ ...chosen, year: '3y', type: 'review', show: 'seen', sort: 'newest' }, store);
    expect(readFilters(store)).toEqual({ free: false, year: '3y', type: 'review', show: 'seen', sort: 'newest' });
  });

  it('falls back to the defaults for anything it does not know, field by field', () => {
    expect(readFilters(memory({ 'skaz.explore.filters': 'not json' }))).toEqual(DEFAULT_FILTERS);
    const odd = memory({ 'skaz.explore.filters': JSON.stringify({ free: 'yes', year: { from: 2020.5, to: 2024 }, type: 'book', show: 'all', sort: 'random' }) });
    expect(readFilters(odd)).toEqual(DEFAULT_FILTERS);
    // a valid field next to invalid ones survives
    const mixed = memory({ 'skaz.explore.filters': JSON.stringify({ free: false, year: '1y', type: 'nonsense' }) });
    expect(readFilters(mixed)).toEqual({ ...DEFAULT_FILTERS, free: false, year: '1y' });
  });

  it('works without storage, and a full or blocked storage only forgets the choice', () => {
    expect(readFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(() => writeFilters(DEFAULT_FILTERS, null)).not.toThrow();
    const blocked = { setItem: vi.fn(() => { throw new Error('QuotaExceededError'); }) };
    expect(() => writeFilters(DEFAULT_FILTERS, blocked)).not.toThrow();
    expect(readFilters({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_FILTERS);
  });

  it('keeps one key: the choice applies to every search', () => {
    const store = memory();
    writeFilters(DEFAULT_FILTERS, store);
    expect([...store.data.keys()]).toEqual(['skaz.explore.filters']);
  });
});

describe('EX3 filters — the query of one search page', () => {
  const today = new Date('2026-11-12T10:00:00Z');

  it('asks for the run, the Show state, Free only and the sort, with a page of 100', () => {
    expect(filtersQuery('run-1', DEFAULT_FILTERS, today)).toEqual({ run_id: 'run-1', show: 'active', free_only: true, sort: 'for_you', limit: 100 });
  });

  it('turns «last 12 months» and «last 3 years» into a first year relative to today', () => {
    expect(filtersQuery('r', { ...DEFAULT_FILTERS, year: '1y' }, today)).toMatchObject({ year_from: 2025 });
    expect(filtersQuery('r', { ...DEFAULT_FILTERS, year: '3y' }, today)).toMatchObject({ year_from: 2023 });
    expect(filtersQuery('r', { ...DEFAULT_FILTERS, year: '3y' }, today)).not.toHaveProperty('year_to');
  });

  it('sends a year range as both ends and a type as a one-item list', () => {
    const q = filtersQuery('r', { ...DEFAULT_FILTERS, year: { from: 2022, to: 2024 }, type: 'preprint', free: false, show: 'new', sort: 'newest' }, today);
    expect(q).toEqual({ run_id: 'r', show: 'new', free_only: false, sort: 'newest', year_from: 2022, year_to: 2024, types: ['preprint'], limit: 100 });
  });

  it('sends no year and no types when they are not chosen', () => {
    const q = filtersQuery('r', DEFAULT_FILTERS, today);
    expect(q).not.toHaveProperty('year_from');
    expect(q).not.toHaveProperty('types');
  });
});

describe('EX3 filters — labels and what counts as changed', () => {
  it('names every choice for its button', () => {
    expect(YEAR_LABEL('any')).toBe('Year');
    expect(YEAR_LABEL('1y')).toBe('Last 12 months');
    expect(YEAR_LABEL('3y')).toBe('Last 3 years');
    expect(YEAR_LABEL({ from: 2022, to: 2024 })).toBe('2022–2024');
    expect(TYPE_LABEL).toMatchObject({ any: 'Type', preprint: 'Preprints', peer_reviewed: 'Peer-reviewed', review: 'Reviews' });
    expect(SHOW_LABEL).toEqual({ active: 'New & seen', new: 'New', seen: 'Seen', dismissed: 'Not for me' });
    expect(SORT_LABEL).toEqual({ for_you: 'For you first', newest: 'Newest first', cited: 'Most cited' });
  });

  it('says a filter is active when year, type or Show is off its default (Free only and Sort are not counted)', () => {
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILTERS, free: false, sort: 'cited' })).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILTERS, year: '1y' })).toBe(true);
    expect(filtersActive({ ...DEFAULT_FILTERS, type: 'other' })).toBe(true);
    expect(filtersActive({ ...DEFAULT_FILTERS, show: 'dismissed' })).toBe(true);
  });
});
