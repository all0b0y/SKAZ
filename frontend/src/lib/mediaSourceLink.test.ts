import { expect, it } from 'vitest';
import { mediaSourceLink } from './mediaSourceLink';

it('links to the original whole-video timeline', () => {
  expect(mediaSourceLink('abcdefghijk', 65001)).toBe('https://www.youtube.com/watch?v=abcdefghijk&t=65s');
});
it('rejects untrusted identifiers and invalid time', () => {
  expect(mediaSourceLink('javascript:alert(1)', 0)).toBeNull();
  expect(mediaSourceLink('abcdefghijk', -1)).toBeNull();
  expect(mediaSourceLink('abcdefghijk', NaN)).toBeNull();
});
