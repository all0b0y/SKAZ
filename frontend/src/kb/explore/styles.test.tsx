import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { auditCss } from '../board/audit';
import { KbServicesProvider } from '../state/context';
import { ExploreSection } from './ExploreSection';
import { exploreHarness, exploreWorld } from './test/fixtures';

const dir = __dirname;
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8');
const v2 = read('explore-v2.css');
const shared = read('explore.css');
const tokens = readFileSync(resolve(dir, '../styles/tokens.css'), 'utf8');
const sources = readdirSync(dir)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
  .map((f) => ({ name: f, text: read(f) }));

/** The value of one rule's declarations, so a test can say what a selector does and does not do. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
};

afterEach(cleanup);

describe('Explore styles — tokens only (DESIGN-SYSTEM.md, token lint)', () => {
  const audit = auditCss({ 'explore.css': shared, 'explore-v2.css': v2 });
  /** 1px hairlines and offsets above the largest step are not rhythm (as in kb/styles/tokens.lint.test.ts). */
  const spacingAllowed = (value: string) => value === '1px' || parseFloat(value) > 34;

  it('has no literal colours', () => expect(audit.colors).toEqual([]));
  it('has no font sizes in px', () => expect(audit.fontSizes.filter((t) => !t.value.endsWith('em'))).toEqual([]));
  it('has no border radii in px other than hairlines', () => expect(audit.radii).toEqual([]));
  it('takes padding, margin and gap from the --kb-sp-* steps', () => expect(audit.spacing.filter((s) => !spacingAllowed(s.value))).toEqual([]));
  it('takes elevation from --kb-shadow-* tokens', () => expect(audit.shadows).toBe(0));

  it('uses only tokens that exist (or that the sheet itself defines)', () => {
    const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const own of v2.matchAll(/(--kb-ex-[\w-]+)\s*:/g)) defined.add(own[1]);
    const used = new Set([...(v2 + shared).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((token) => !defined.has(token!))).toEqual([]);
  });
});

describe('Explore styles — every class is drawn, and every rule is used', () => {
  const classesIn = (text: string) => new Set([...text.matchAll(/(?<![\w-])(kb-ex(?:-[a-z0-9]+)*(?:__[a-z0-9-]+)?(?:--[a-z0-9-]+)?)(?![\w-])/g)].map((m) => m[1]!));
  const cssClasses = classesIn(v2);
  const used = classesIn(sources.map((s) => s.text).join('\n'));

  it('every kb-ex-* class a component uses has a rule', () => {
    expect([...used].filter((c) => !cssClasses.has(c)).sort()).toEqual([]);
  });

  it('every kb-ex-* rule belongs to a class a component uses (no dead rules)', () => {
    expect([...cssClasses].filter((c) => !used.has(c)).sort()).toEqual([]);
  });

  it('keeps the old screen\'s selectors out of both sheets', () => {
    for (const gone of ['kb-explore-tile', 'kb-explore-search', 'kb-explore-col', 'kb-explore-tabs', 'kb-explore-map', 'kb-search-plan', 'kb-topic-picker']) {
      expect(v2 + shared).not.toContain(gone);
    }
  });
});

describe('Explore styles — what the decisions say the screen must not do', () => {
  it('UX-4: the find bar has no frame and no highlight', () => {
    const field = rule(v2, '.kb-ex-bar__field');
    expect(field).not.toMatch(/(^|[;\s])border(-(top|right|bottom|left|width|style|color))?\s*:|outline|box-shadow/);
    expect(v2).not.toMatch(/:focus-within/);
    expect(rule(v2, '.kb-ex-bar__input:focus-visible')).toMatch(/outline:\s*none/);
    expect(rule(v2, '.kb-ex-bar')).not.toMatch(/(^|[;\s])border\s*:|outline/);   // only the line under the bar
  });

  it('UX-14: nothing animates or slides — no transitions, keyframes, fixed panels or sideways moves', () => {
    expect(v2).not.toMatch(/\btransition\b|@keyframes|\banimation\b/);
    expect(v2).not.toMatch(/position:\s*fixed|translateX|translate:\s*-?\d+(px|%)\s+0\b/);
    expect(v2).not.toMatch(/(^|[;{\s])width\s*:\s*0(px)?\s*[;}]/);   // no panel that grows from nothing
  });

  it('UX-14: the topic panel has a fixed width, and the reader slot is always laid out with a size of its own', () => {
    expect(rule(v2, '.kb-ex-detail')).toMatch(/\bwidth:\s*300px/);
    expect(rule(v2, '.kb-ex-detail')).toMatch(/flex:\s*none/);
    const slot = rule(v2, '.kb-ex-reader__slot');
    expect(slot).toMatch(/flex:\s*1/);
    expect(slot).toMatch(/min-height:\s*0/);
    expect(slot).not.toMatch(/display:\s*none|visibility/);
  });

  it('UX-14: a row does not change size when it is opened or marked seen (only colour changes)', () => {
    for (const state of ['.kb-ex-row.is-open', '.kb-ex-row:hover']) {
      expect(rule(v2, state)).not.toMatch(/padding|margin|border|width|height|font-size/);
    }
  });

  it('the side list\'s actions button replaces the status instead of making room for it', () => {
    expect(rule(v2, '.kb-ex-side__item .kb-ex-side__more')).toMatch(/position:\s*absolute/);
    expect(v2).toMatch(/\.kb-ex-side__item:hover \.kb-ex-side__status[\s\S]*?visibility:\s*hidden/);
  });
});

describe('Explore styles — the shell can hide the page (a document opened full width)', () => {
  it('hides the pane with its actual CSS, not only the [hidden] attribute', () => {
    const style = document.createElement('style');
    style.textContent = `${shared}\n${v2}`;
    document.head.append(style);
    try {
      const { services } = exploreHarness(exploreWorld());
      render(<KbServicesProvider services={services}><ExploreSection hidden /></KbServicesProvider>);
      const pane = document.querySelector<HTMLElement>('[data-pane="explore"]')!;
      expect(pane.hidden).toBe(true);
      // jsdom's own rule for [hidden] differs from Chromium's author cascade: check the author rule too.
      expect(rule(v2, '.kb-ex[hidden]')).toMatch(/display:\s*none/);
      expect(getComputedStyle(pane).display).toBe('none');
    } finally {
      style.remove();
    }
  });

  it('is a sheet like the other centre views: pane ground, rounded, clipped', () => {
    const root = rule(v2, '.kb-ex');
    expect(root).toMatch(/background:\s*var\(--kb-pane\)/);
    expect(root).toMatch(/border-radius:\s*var\(--kb-r-xl\)/);
    expect(root).toMatch(/overflow:\s*hidden/);
    expect(root).toMatch(/container:\s*kb-ex\s*\/\s*inline-size/);
  });
});
