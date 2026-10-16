import { describe, expect, it } from 'vitest';
import { findCitationForSelection, matchCitation } from './citationMatch';

const citation = (text: string, segment_id = 'seg-1') => ({
  segment_id, start_ms: 0, end_ms: 1_000, text,
});

describe('matchCitation', () => {
  it('matches when the selection is an exact substring of a citation', () => {
    const c = citation('The quarterly revenue grew by twelve percent this year.');
    const result = matchCitation('quarterly revenue grew', [c]);
    expect(result).toEqual({ citation: c, strategy: 'exact-substring' });
  });

  it('matches when the citation text is a substring of a wider selection', () => {
    const c = citation('short quote');
    const result = matchCitation('Some preamble, short quote, and a trailing remark.', [c]);
    expect(result).toEqual({ citation: c, strategy: 'reverse-substring' });
  });

  it('matches via normalized word overlap when punctuation/case/spacing differ', () => {
    const c = citation('Revenue,   grew — by TWELVE percent!');
    const result = matchCitation('revenue grew by twelve percent', [c]);
    expect(result).toEqual({ citation: c, strategy: 'normalized-words' });
  });

  it('matches cyrillic text via normalized word overlap', () => {
    const c = citation('Матан сдаётся в конце семестра, это важно.');
    const result = matchCitation('матан сдаётся в конце семестра', [c]);
    expect(result?.strategy).toBe('normalized-words');
    expect(result?.citation).toBe(c);
  });

  it('returns null when there is no meaningful overlap', () => {
    const c = citation('Completely unrelated sentence about the weather.');
    expect(matchCitation('quarterly revenue numbers', [c])).toBeNull();
  });

  it('returns null for a short, ambiguous selection rather than guessing', () => {
    const c = citation('We reviewed the annual budget again next quarter.');
    // Too few words to trust a normalized match, and not a literal substring either way.
    expect(matchCitation('the budget', [c])).toBeNull();
  });

  it('returns null for an empty selection', () => {
    const c = citation('Some citation text here.');
    expect(matchCitation('   ', [c])).toBeNull();
  });

  it('returns null when there are no citations', () => {
    expect(matchCitation('anything at all here', [])).toBeNull();
  });

  it('prefers the first exact match over a later, less relevant citation', () => {
    const first = citation('The launch date moved to March.', 'seg-a');
    const second = citation('The launch date moved to March, again.', 'seg-b');
    const result = matchCitation('launch date moved to March', [first, second]);
    expect(result?.citation).toBe(first);
  });

  it('picks the highest-scoring normalized match among several candidates', () => {
    const weak = citation('revenue grew somewhat over the period in question', 'seg-weak');
    const strong = citation('Revenue grew by twelve percent this quarter.', 'seg-strong');
    const result = matchCitation('revenue grew by twelve percent', [weak, strong]);
    expect(result?.citation).toBe(strong);
    expect(result?.strategy).toBe('normalized-words');
  });

  it('findCitationForSelection returns the citation directly, or null', () => {
    const c = citation('quarterly revenue grew by twelve percent');
    expect(findCitationForSelection('quarterly revenue grew', [c])).toBe(c);
    expect(findCitationForSelection('nothing in common whatsoever', [c])).toBeNull();
  });
});
