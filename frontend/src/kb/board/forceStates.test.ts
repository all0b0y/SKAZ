import { describe, expect, it } from 'vitest';
import { forcedSelector, splitSelectorList } from './forceStates';

describe('splitSelectorList', () => {
  it('splits at top-level commas only', () => {
    expect(splitSelectorList('.a, .b:not(.c, .d) .e,.f')).toEqual(['.a', '.b:not(.c, .d) .e', '.f']);
  });
});

describe('forcedSelector', () => {
  it('drops the pseudo-class and scopes the rule to a board cell', () => {
    expect(forcedSelector('.kb-btn--fill:hover:not(:disabled)', 'hover'))
      .toBe('[data-force~="hover"] .kb-btn--fill:not(:disabled)');
    expect(forcedSelector('.kb-menu__item:hover .kb-menu__note', 'hover'))
      .toBe('[data-force~="hover"] .kb-menu__item .kb-menu__note');
  });

  it('keeps only the parts of a list that carry the state', () => {
    expect(forcedSelector('.kb-menu__item:hover:not([aria-disabled=\'true\']), .kb-menu__item:focus-visible', 'focus'))
      .toBe('[data-force~="focus"] .kb-menu__item');
    expect(forcedSelector('.a, .b', 'hover')).toBeNull();
  });

  it('keeps a leading html/:root compound in front (the tokens live there)', () => {
    expect(forcedSelector('html[data-kb-ui] .kb-chip:hover', 'hover'))
      .toBe('html[data-kb-ui] [data-force~="hover"] .kb-chip');
  });

  it('maps pressed to :active, focus to :focus-visible and :focus-within, and leaves :focus alone', () => {
    expect(forcedSelector('.x:active', 'pressed')).toBe('[data-force~="pressed"] .x');
    expect(forcedSelector('.kb-field__box:focus-within', 'focus')).toBe('[data-force~="focus"] .kb-field__box');
    expect(forcedSelector('.x:focus', 'focus')).toBeNull();
  });

  it('turns a stand-alone pseudo-class (the global focus ring) into the cell\'s own child', () => {
    expect(forcedSelector(':where(html[data-kb-ui]) :focus-visible', 'focus'))
      .toBe(':where(html[data-kb-ui]) [data-force~="focus"] > :is(button, input, a)');
    expect(forcedSelector('.list :hover', 'hover')).toBe('[data-force~="hover"] .list *');
  });
});
