import { expect, test, chromium, type Browser, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { auditPanes } from './paneAudit';

// X6 in a real browser on the shared fake backend (frontend/src/kb/test/harness.tsx, as kb-u2/x4):
// sources as footnote numbers (v42 variant A) in a chat answer and on a wiki page — the user's case
// of seven identical "Seminar Assignment 2 … · p. 1" chips — and the colour agent marks.
// 1440, light and dark; layout audit 0; console clean.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_X6_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-x6');
const THEMES = ['light', 'dark'] as const;

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const consoleErrors: string[] = [];

const SEMINAR = 'Seminar Assignment 2 - The Maplewood Boardroom Dilemma';
const BLACKROCK = 'BlackRock Investment Stewardship Report 2025';

type Cite = { material_id: string; seg: number; available: boolean; material_title: string; start_ms: null; end_ms: null; page: number; quote: string };
type Fake = {
  world: {
    chats: Array<{ id: string; messages: Array<{ parts: unknown[] }> }>;
    pages: Array<{ id: string; title: string; blocks: Array<{ citations: Cite[]; text: string; title: string | null }>; sources: string[] }>;
  };
  services: { ui: { getState: () => { openDocument: (t: { type: 'page'; id: string }) => void } } };
};

/** The user's screenshot, as data: a chat answer and a wiki page citing one seminar file many times. */
async function seed() {
  await page.evaluate(({ SEMINAR, BLACKROCK }) => {
    const fake = (window as unknown as { __kbFake: Fake }).__kbFake;
    const q = (material_id: string, material_title: string, seg: number, p: number, quote: string): Cite => ({
      material_id, seg, available: true, material_title, start_ms: null, end_ms: null, page: p, quote,
    });
    const a = q('m2', SEMINAR, 1, 1, 'Your team acts as Senior Strategic Consultants and must present one clear recommendation to the Board of Trustees.');
    const b = q('m2', SEMINAR, 2, 1, 'Option STAY: remain with BlackRock and influence the low-carbon transition through engagement at scale.');
    const c = q('m2', SEMINAR, 3, 1, 'Option LEAVE: move the mandate to another manager whose commitments match the fund’s 2040 net-zero target.');
    const d = q('m2', SEMINAR, 4, 2, 'If you recommend leaving, you must name the alternative asset manager and justify the choice.');
    const f = q('m1', BLACKROCK, 1, 14, 'In 2025 the firm withdrew from the Net Zero Asset Managers initiative and revised several climate commitments.');
    const g = q('m2', SEMINAR, 5, 1, 'Maplewood Pension Fund, established in 2004, manages €400 million and has historically entrusted its portfolio to BlackRock.');
    const h = q('m1', BLACKROCK, 2, 3, 'Texas removed BlackRock from its list of firms boycotting energy companies in June 2025.');
    const cite = (x: Cite) => ({ type: 'cite', citation: x });
    const text = (t: string) => ({ type: 'text', text: t });
    fake.world.chats.find((x) => x.id === 'c1')!.messages[1]!.parts = [
      text('Короче, это **групповая презентация в роли консультантов**, а не реферат. Нужно убедить совет пенсионного фонда: **оставаться с BlackRock или уходить к другому управляющему**. '),
      cite(a), cite(a),
      text('\n\n**Что конкретно делать**\n\n- **STAY — остаться:** доказывать, что через масштаб BlackRock можно эффективнее влиять на компании. '),
      cite(b),
      text('\n- **LEAVE — уйти:** доказывать, что отход BlackRock от климатических обязательств несовместим с целью net zero к 2040 году. '),
      cite(c), cite(d), cite(f),
      text('\n\n**Обосновать решение фактами**, а не просто «экология — это важно». '),
      cite(a), cite(g),
      text(' Тот же принцип разбирали в лекции. '),
      // Live B5: Codex cited fragments without words — the popup shows the fragment instead.
      { type: 'cite', citation: { material_id: 'm5', seg: 3, available: true, material_title: 'Lecture 5', start_ms: 2_640_000, end_ms: 2_650_000, page: null, quote: null } },
    ];
    const entropy = fake.world.pages.find((x) => x.id === 'p-entropy')!;
    const maple = structuredClone(entropy);
    maple.id = 'p-maple';
    maple.title = 'The Maplewood Boardroom Dilemma';
    const block = structuredClone(entropy.blocks[1]!);
    const at = (id: string, title: string, body: string, cites: Cite[]) => ({ ...structuredClone(block), id, title, text: body, citations: cites });
    maple.blocks = [
      at('mb1', 'Case and decision', 'The Maplewood Boardroom Dilemma is a seminar assignment built around a fictional European institutional fund, Maplewood Pension Fund. Established in 2004, the fund manages €400 million and has historically entrusted its portfolio to BlackRock. Participants take the role of Senior Strategic Consultants advising the fund.', [g, g, g, a, a, a, a]),
      at('mb2', 'Case and decision', 'The case presents BlackRock’s 2025 removal from the Texas fossil fuel blacklist and major rollbacks in its climate commitments as the developments prompting Maplewood’s Board of Trustees to call an extraordinary meeting.', [g, h, f, g, g, g, g]),
    ] as never;
    maple.sources = ['m2', 'm1'];
    fake.world.pages.push(maple as never);
  }, { SEMINAR, BLACKROCK });
}

async function open(theme: 'light' | 'dark', query = '') {
  await page.setViewportSize({ width: 1440, height: 860 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto(`${base}/src/kb/test/harness.html${query}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html${query}`);
  if (query.includes('onboarding=1')) return;
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  await seed();
}

/** Every agent mark on screen is the bundled image at its size, no letters. */
async function marks(expected: number[], root: Locator = page.locator('body')) {
  // Wait for the bundled images to decode before measuring them.
  await expect.poll(() => root.locator('.kb-engine:visible img').evaluateAll((imgs) =>
    imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const got = await root.locator('.kb-engine:visible').evaluateAll((els) => els.map((el) => ({
    size: Math.round(el.getBoundingClientRect().width), text: el.textContent ?? '',
    loaded: (el.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? 0,
  })));
  expect(got.map((m) => m.size)).toEqual(expected);
  for (const m of got) { expect(m.text).toBe(''); expect(m.loaded).toBeGreaterThan(0); }
}

async function check(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  const panes = await page.evaluate(auditPanes);
  expect(panes, `${name}: pane violations ${JSON.stringify(panes, null, 1)}`).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false,
    root: path.join(root, 'frontend'),
    plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'frontend/src') } },
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer!.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  browser = await chromium.launch();
  page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

for (const theme of THEMES) {
  test(`chat answer: footnote numbers, Sources row, quote popup — 1440 ${theme}`, async () => {
    await open(theme);
    await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Why is there a logarithm/ }).click();
    const answer = page.getByRole('article', { name: 'Answer' });
    // Seven chips became numbers: duplicates merged, one number per document.
    await expect(answer.locator('.kb-chip[data-kind="document"]')).toHaveCount(0);
    await expect(answer.locator('.kb-cn')).toHaveText(['1', '1', '1', '2', '1', '3']);
    const sources = answer.getByRole('group', { name: 'Sources' });
    await expect(sources.getByRole('button')).toHaveText([`1${SEMINAR}`, `2${BLACKROCK}`, '3Lecture 5']);
    await page.mouse.move(2, 300);
    await check(`chat-answer-1440-${theme}`);
    // Hover the LEAVE claim's first number: both of its seminar quotes, with pages.
    await answer.locator('.kb-cn').nth(2).hover();
    const pop = page.getByRole('dialog', { name: SEMINAR });
    await expect(pop.locator('blockquote')).toHaveCount(2);
    await expect(pop.getByText('p. 2')).toBeVisible();
    await check(`chat-popover-1440-${theme}`);
    // The popup stays inside the window and does not cover its own mark.
    const box = (await pop.boundingBox())!;
    const mark = (await answer.locator('.kb-cn').nth(2).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(1440);
    expect(box.y).toBeGreaterThanOrEqual(mark.y + mark.height);
    // No exact words: the start of the cited fragment, labelled "Fragment", and "Open at fragment".
    await page.mouse.move(2, 300);
    await expect(pop).toHaveCount(0);
    await answer.locator('.kb-cn').nth(5).hover();
    const bare = page.getByRole('dialog', { name: 'Lecture 5' });
    await expect(bare.getByText('Fragment', { exact: true })).toBeVisible();
    await expect(bare.getByText('This is Shannon entropy applied to the model’s error.')).toBeVisible();
    await expect(bare.getByRole('button', { name: 'Open at fragment, 44:00' })).toBeVisible();
    await check(`chat-fragment-popover-1440-${theme}`);
  });

  test(`wiki page: numbers at the end of each claim, Sources at the end of the page — 1440 ${theme}`, async () => {
    await open(theme);
    await page.evaluate(() => (window as unknown as { __kbFake: Fake }).__kbFake.services.ui.getState().openDocument({ type: 'page', id: 'p-maple' }));
    const doc = page.getByRole('complementary', { name: 'Document' });
    await expect(doc.getByRole('heading', { level: 2, name: 'The Maplewood Boardroom Dilemma' })).toBeVisible();
    await expect(doc.locator('.kb-block__cites .kb-cn')).toHaveText(['1', '1', '2']);
    await expect(doc.getByRole('group', { name: 'Sources' }).getByRole('button')).toHaveText([`1${SEMINAR}`, `2${BLACKROCK}`]);
    await page.mouse.move(2, 300);
    await check(`wiki-page-1440-${theme}`);
    await doc.locator('.kb-block__cites .kb-cn').first().click();
    const pop = page.getByRole('dialog', { name: SEMINAR });
    await expect(pop.locator('blockquote')).toHaveCount(2);
    await expect(pop.getByRole('button', { name: /^Open at quote/ }).first()).toBeFocused();
    await check(`wiki-popover-1440-${theme}`);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(doc.locator('.kb-block__cites .kb-cn').first()).toBeFocused();
    // Expanded to the centre: the same marks, wider text.
    await page.getByRole('button', { name: 'Expand to the centre' }).click();
    await page.mouse.move(2, 300);
    await check(`wiki-page-wide-1440-${theme}`);
  });
}

for (const theme of THEMES) {
  test(`agent marks: composer 16, agent menu 20, Settings rows 20, first-launch cards 32 — 1440 ${theme}`, async () => {
    await open(theme);
    await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Why is there a logarithm/ }).click();
    await marks([16]);
    await page.getByTestId('agent-picker').click();
    await expect(page.getByRole('menu', { name: 'Agent and model' })).toBeVisible();
    await marks([16, 20, 20, 20]);
    await check(`logos-composer-menu-1440-${theme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+Comma');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('navigation').getByRole('button', { name: /^Accounts & keys/ }).click();
    await expect(settings.locator('.kb-engine')).toHaveCount(3);
    await marks([20, 20, 20], settings);
    await check(`logos-settings-1440-${theme}`);
    await page.keyboard.press('Escape');
    await open(theme, '?onboarding=1');
    const dialog = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.locator('.kb-engine')).toHaveCount(3);
    await marks([32, 32, 32], dialog);
    await check(`logos-onboarding-1440-${theme}`);
  });
}

test('console stayed clean', () => {
  expect(consoleErrors).toEqual([]);
});
