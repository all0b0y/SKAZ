import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTokenBlocks, themeValue, tokenGroups } from './tokens';

// Vitest does not process CSS, so `?raw` is empty here: read the file itself.
const tokensCss = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');

describe('tokens.css inventory', () => {
  const blocks = parseTokenBlocks(tokensCss);

  it('finds the base block and the text-size blocks', () => {
    expect(themeValue(blocks.light.get('--kb-bg')!, 'light')).toBe('#f9f8f3');
    expect(themeValue(blocks.light.get('--kb-bg')!, 'dark')).toBe('#1e1f21');
    expect(blocks.textSize.s?.get('--t-base')).toBe('13px');
    expect(blocks.textSize.l?.get('--t-base')).toBe('14.5px');
  });

  it('sorts every token into exactly one group', () => {
    const groups = tokenGroups(blocks.light);
    const all = Object.values(groups).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(blocks.light.size);
    expect(groups.color).toContain('--kb-text');
    expect(groups.type).toContain('--t-badge');
    expect(groups.radius).toContain('--kb-r-2xs');
    expect(groups.space).toEqual(expect.arrayContaining(['--kb-density', '--kb-sp-2', '--kb-sp-34']));
    expect(groups.shadow).toContain('--kb-shadow-card');
    expect(groups.font).toContain('--kb-font-display');
    expect(groups.chrome).toContain('--kb-rail-w');
  });

  // Stage 2: one declaration per colour (light-dark). No twin dark blocks to keep in sync any more.
  it('declares every token once: no dark blocks, no stray token blocks', () => {
    expect(tokensCss).not.toMatch(/prefers-color-scheme/);
    expect(blocks.stray).toEqual([]);
  });

  it('keeps the dark surfaces ordered rail < side < bg < pane (F1)', () => {
    const dark = ['--kb-rail', '--kb-side', '--kb-bg', '--kb-pane'].map((n) => themeValue(blocks.light.get(n)!, 'dark'));
    expect(dark).toEqual(['#141517', '#191a1c', '#1e1f21', '#2c2e31']);
  });

  it('reads every knob variant; each base/accent declares the same tokens as the default', () => {
    expect(Object.keys(blocks.bases)).toEqual(['milk', 'paper', 'slate', 'sand']);
    expect(Object.keys(blocks.accents)).toEqual(['ink', 'clay', 'petrol', 'plum', 'slate']);
    expect(Object.keys(blocks.density)).toEqual(['compact', 'spacious']);
    const keys = (m: Map<string, string>) => [...m.keys()].sort();
    for (const b of Object.values(blocks.bases)) expect(keys(b)).toEqual(keys(blocks.bases.milk!));
    for (const a of Object.values(blocks.accents)) expect(keys(a)).toEqual(keys(blocks.accents.ink!));
    for (const d of Object.values(blocks.density)) expect(keys(d).every((k) => blocks.light.has(k))).toBe(true);
  });

  it('picks a side of light-dark(), including rgba() arguments', () => {
    expect(themeValue('0 1px 2px light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.4))', 'dark')).toBe('0 1px 2px rgba(0, 0, 0, 0.4)');
    expect(themeValue('light-dark(#fff, #000)', 'light')).toBe('#fff');
  });
});
