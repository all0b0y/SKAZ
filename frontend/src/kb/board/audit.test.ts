import { describe, expect, it } from 'vitest';
import { auditCss } from './audit';

const SAMPLE = `
/* a comment with #123456 and 13px is ignored */
.a { color: #fff; background: rgba(0, 0, 0, 0.5); border: 1px solid var(--kb-line, #ddd); }
.b { font-size: 13px; border-radius: 10px; padding: 6px 10px; gap: var(--kb-s-2); }
.c { font-size: var(--t-sm); border-radius: var(--kb-r-sm); margin: 0 auto; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
.d { border-radius: 50%; padding: 8px; }
.e { box-shadow: 0 0 0 3px color-mix(in srgb, var(--kb-danger) 18%, transparent); border-radius: 1px; }
.f { box-shadow: inset 0 -2px 0 var(--kb-line); }
`;

describe('auditCss', () => {
  const r = auditCss({ 'x.css': SAMPLE });

  it('counts literal colours, but not var() fallbacks or comments', () => {
    expect(r.colors.map((c) => c.value).sort()).toEqual(['#fff', 'rgba(0, 0, 0, 0.5)', 'rgba(0,0,0,.1)']);
    expect(r.colors.every((c) => c.file === 'x.css')).toBe(true);
  });

  it('collects literal font sizes and radii (not tokens, not 50 %)', () => {
    expect(r.fontSizes).toEqual([{ value: '13px', count: 1, files: ['x.css'] }]);
    expect(r.radii).toEqual([{ value: '10px', count: 1, files: ['x.css'] }]);
  });

  it('builds a px spacing histogram and flags values off the 4 px grid', () => {
    const byValue = Object.fromEntries(r.spacing.map((s) => [s.value, s]));
    expect(byValue['6px']).toMatchObject({ count: 1, onGrid: false });
    expect(byValue['10px']).toMatchObject({ count: 1, onGrid: false });
    expect(byValue['8px']).toMatchObject({ count: 1, onGrid: true });
    expect(byValue['0']).toBeUndefined();
  });

  it('counts elevation box-shadows not taken from a token, not rings or insets', () => {
    expect(r.shadows).toBe(1);
  });
});
