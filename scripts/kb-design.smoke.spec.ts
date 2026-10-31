import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { contrast, hueDistance, oklch, parseColor, type Rgba } from '../frontend/src/kb/ui/color';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Design-system contrast gate (.dev/docs/DESIGN-SYSTEM.md, verification 1): the real built Electron
// app, isolated profile. Every theme the user can choose is forced on <html>; each colour token is
// resolved by the renderer itself (light-dark, color-mix) and the pairs the UI actually draws must
// reach WCAG AA — for every base × accent × theme the Appearance settings allow (stage 3).

const THEMES = ['light', 'dark'] as const;
const BASES = ['milk', 'paper', 'slate', 'sand'] as const;
const ACCENTS = ['ink', 'clay', 'petrol', 'plum', 'slate'] as const;
const STATES = ['--kb-danger', '--kb-warn', '--kb-ok'];

/** Text needs 4.5:1, graphics (dots, folder marks, FX) 3:1. */
const TEXT = ['--kb-text', '--kb-muted', '--kb-muted-strong', '--kb-accent', '--kb-danger', '--kb-warn', '--kb-ok'];
const GRAPHIC = ['--kb-folder-1', '--kb-folder-2', '--kb-folder-3', '--kb-folder-4', '--kb-fx-accent'];
const GROUNDS = ['--kb-bg', '--kb-pane', '--kb-side', '--kb-rail', '--kb-accent-soft'];
const PAIRS: ReadonlyArray<[string, string]> = [
  ['--kb-on-fill', '--kb-fill'], ['--kb-badge-text', '--kb-danger'], ['--kb-bg', '--kb-text'],
  ['--kb-danger', '--kb-danger-soft'], ['--kb-warn', '--kb-warn-soft'], ['--kb-ok', '--kb-ok-soft'],
  ['--kb-text', '--kb-accent-press'],
];
const SURFACES = ['--kb-rail', '--kb-side', '--kb-bg', '--kb-pane'];
const ALL = [...new Set([...TEXT, ...GRAPHIC, ...GROUNDS, ...PAIRS.flat(), ...SURFACES, '--kb-fill'])];

let app: ElectronApplication;
let page: Page;
let close: () => Promise<void>;

test.beforeAll(async () => {
  ({ app, close } = await launchIsolatedSmoke('skaz-kb-design-'));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-kb-ui'));
});

test.afterAll(async () => { await close?.(); });

async function resolveTokens(theme: string, base: string, accent: string): Promise<Record<string, string>> {
  return page.evaluate(({ theme: t, base: b, accent: a, names }) => {
    const html = document.documentElement;
    Object.assign(html.dataset, { theme: t, base: b, accent: a });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const out: Record<string, string> = {};
    for (const name of names) {
      const probe = document.createElement('i');
      probe.style.backgroundColor = `var(${name})`;
      host.appendChild(probe);
      out[name] = getComputedStyle(probe).backgroundColor;
    }
    host.remove();
    return out;
  }, { theme, base, accent, names: ALL });
}

for (const theme of THEMES) for (const base of BASES) {
  test(`tokens reach WCAG AA: ${base} · ${theme} · every accent`, async () => {
   for (const accent of ACCENTS) {
    const raw = await resolveTokens(theme, base, accent);
    const c: Record<string, Rgba> = {};
    for (const [name, value] of Object.entries(raw)) {
      const parsed = parseColor(value);
      expect(parsed, `${name} resolves (${value})`).not.toBeNull();
      c[name] = parsed!;
    }
    const fails: string[] = [];
    const check = (fg: string, bg: string, min: number) => {
      const r = contrast(c[fg]!, c[bg]!);
      if (r < min) fails.push(`${accent}: ${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const bg of GROUNDS) {
      for (const fg of TEXT) check(fg, bg, 4.5);
      for (const fg of GRAPHIC) check(fg, bg, 3);
    }
    for (const [fg, bg] of PAIRS) check(fg, bg, 4.5);

    // Surfaces are ordered darkest → lightest with a visible step (F1, principle 4).
    const l = SURFACES.map((n) => oklch(c[n]!).l);
    for (let i = 1; i < l.length; i += 1) expect(l[i]! - l[i - 1]!, `${SURFACES[i - 1]} → ${SURFACES[i]}`).toBeGreaterThanOrEqual(0.019);

    // The accent never shares the hue of a folder or a state colour — unless it is muted (chroma
    // ≤ 0.07) next to a colour at least 1.4× as saturated (greys have no hue).
    const ac = oklch(c['--kb-accent']!);
    for (const other of [...GRAPHIC.slice(0, 4), ...STATES]) {
      const oc = oklch(c[other]!);
      const d = hueDistance(ac.h, oc.h);
      if (d !== null && d < 30 && !(ac.c <= 0.07 && oc.c >= 1.4 * ac.c)) fails.push(`${accent}: hue ${Math.round(d)}° from ${other}`);
    }
    expect(fails).toEqual([]);
   }
  });
}
