import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { contrast, hueDistance, oklch, parseColor, type Rgba } from '../frontend/src/kb/ui/color';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Design-system contrast gate (.dev/docs/DESIGN-SYSTEM.md, verification 1): the real built Electron
// app, isolated profile. Every theme the user can choose is forced on <html>; each colour token is
// resolved by the renderer itself (light-dark, color-mix) and the pairs the UI actually draws must
// reach WCAG AA. Stage 3 widens THEMES to every base × accent × theme.

const THEMES = ['light', 'dark'] as const;

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
const ALL = [...new Set([...TEXT, ...GRAPHIC, ...GROUNDS, ...PAIRS.flat(), ...SURFACES])];

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

async function resolveTokens(theme: string): Promise<Record<string, string>> {
  return page.evaluate(({ theme: t, names }) => {
    const html = document.documentElement;
    html.dataset.theme = t;
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
  }, { theme, names: ALL });
}

for (const theme of THEMES) {
  test(`tokens reach WCAG AA in ${theme}`, async () => {
    const raw = await resolveTokens(theme);
    const c: Record<string, Rgba> = {};
    for (const [name, value] of Object.entries(raw)) {
      const parsed = parseColor(value);
      expect(parsed, `${name} resolves (${value})`).not.toBeNull();
      c[name] = parsed!;
    }
    const fails: string[] = [];
    const check = (fg: string, bg: string, min: number) => {
      const r = contrast(c[fg]!, c[bg]!);
      if (r < min) fails.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    };
    for (const bg of GROUNDS) {
      for (const fg of TEXT) check(fg, bg, 4.5);
      for (const fg of GRAPHIC) check(fg, bg, 3);
    }
    for (const [fg, bg] of PAIRS) check(fg, bg, 4.5);
    expect(fails).toEqual([]);

    // Surfaces are ordered darkest → lightest with a visible step (F1, principle 4).
    const l = SURFACES.map((n) => oklch(c[n]!).l);
    for (let i = 1; i < l.length; i += 1) expect(l[i]! - l[i - 1]!, `${SURFACES[i - 1]} → ${SURFACES[i]}`).toBeGreaterThanOrEqual(0.019);

    // The accent (ink today) never shares a folder's hue (greys have none).
    for (const f of GRAPHIC.slice(0, 4)) {
      const d = hueDistance(oklch(c['--kb-accent']!).h, oklch(c[f]!).h);
      if (d !== null) expect(d, `accent vs ${f}`).toBeGreaterThanOrEqual(30);
    }
  });
}
