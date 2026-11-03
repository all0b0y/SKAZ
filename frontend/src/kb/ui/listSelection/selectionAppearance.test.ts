import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = resolve(__dirname, '../../styles');
const selection = readFileSync(resolve(styles, 'selection.css'), 'utf8');

describe('Decision 31 selection appearance', () => {
  it('uses a row-only round marker, keeping the table header checkbox distinct', () => {
    const rowRule = /\.kb-selslot\s+\.kb-selbox\s*\{([^}]+)\}/.exec(selection)?.[1];
    expect(rowRule).toContain('border-radius: var(--kb-r-pill)');
    expect(selection).toMatch(/\.kb-selbox\s*\{[^}]*border-radius: var\(--kb-r-2xs\)/);
  });

  it('does not paint selected row backgrounds over the current/open surface', () => {
    const painted: string[] = [];
    for (const file of readdirSync(styles).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(resolve(styles, file), 'utf8');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        if (selector!.includes('aria-selected') && /(?:\bli\[|\btr\[|kb-allchats__row|kb-deck__row)/.test(selector!) && /\bbackground(?:-color)?\s*:/.test(body!)) {
          painted.push(`${file}: ${selector!.trim()}`);
        }
      }
    }
    expect(painted).toEqual([]);
  });
});
