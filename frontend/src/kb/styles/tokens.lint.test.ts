import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditCss } from '../board/audit';

/**
 * Token lint (DESIGN-SYSTEM.md, verification 2): the renderer CSS takes colours, font sizes, radii,
 * spacing and elevation from tokens.css, so the theme / text-size / density knobs reach everything.
 * Not checked: tokens.css itself, the dev-only board, inline styles in TSX.
 */

const SRC = resolve(__dirname, '../..');
const DIRS = ['kb/styles', 'kb/fx', 'kb/material', 'brand'];
const files: Record<string, string> = {};
for (const dir of DIRS) {
  for (const f of readdirSync(resolve(SRC, dir))) {
    if (f.endsWith('.css') && f !== 'tokens.css') files[`${dir}/${f}`] = readFileSync(resolve(SRC, dir, f), 'utf8');
  }
}
const audit = auditCss(files);

/** Allowed literals, each with its reason. */
const COLOR_EXCEPTIONS = [
  // Provider/engine logos are drawn for a white tile in both themes.
  { file: 'kb/styles/onboarding.css', value: '#fff' },
];
/** 1px nudges/hairlines and layout offsets above the largest step are not rhythm. */
const spacingAllowed = (v: string) => v === '1px' || parseFloat(v) > 34;

describe('token lint', () => {
  it('reads every renderer stylesheet', () => {
    expect(Object.keys(files).length).toBeGreaterThan(15);
  });

  it('has no literal colours outside tokens.css (except the listed ones)', () => {
    expect(audit.colors).toEqual(COLOR_EXCEPTIONS);
  });

  it('has no font sizes in px (em stays relative to a tokenised parent)', () => {
    expect(audit.fontSizes.filter((t) => !t.value.endsWith('em'))).toEqual([]);
  });

  it('has no border radii in px other than 1px hairlines', () => {
    expect(audit.radii).toEqual([]);
  });

  it('takes padding / margin / gap from --kb-sp-* steps', () => {
    expect(audit.spacing.filter((s) => !spacingAllowed(s.value))).toEqual([]);
  });

  it('takes elevation shadows from --kb-shadow-* tokens', () => {
    expect(audit.shadows).toBe(0);
  });
});
