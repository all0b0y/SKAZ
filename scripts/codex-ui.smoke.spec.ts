import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex Assistant/Notes UI in the built Electron app, isolated profile only.
//
// Part 1 drives the REAL managed backend: the preload bridge must pass the
// Codex contract routes (no IPC policy rejection) and the UI must report what
// the backend actually serves. It does not log in, start tasks, call a model or
// read any user profile. Part 2 lays out real CodexAssistant markup dumped from
// the authored contract fixture (CodexAssistant.dump.test.tsx) with the built
// CSS — a layout check, not evidence of a working Codex path.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'codex-ui');
const dump = path.join(shots, 'dump');

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-codex-ui-')));
  app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: userData, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0',
    },
  });
  // The real profile must never be touched: prove the relocation before any write.
  const actual = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(fs.realpathSync(actual)).toBe(userData);
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 860 });
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  // Isolated onboarding preference only (as panels.smoke): no credentials or consent.
  await page.evaluate(async () => {
    const response = await window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
    if (!response.ok) throw new Error('Fixture onboarding failed');
  });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

/**
 * The one Assistant look on the real backend: same header/scope/composer for
 * both engines, and only the controls the engine really supports.
 */
async function expectShell(engine: 'api' | 'codex') {
  const panel = page.getByRole('region', { name: 'Assistant' });
  await expect(panel).toHaveAttribute('data-engine', engine, { timeout: 15_000 });
  const head = panel.locator('header.codex-head');
  await expect(head.locator('.codex-head__scope')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Question' })).toBeVisible();
  await expect(panel.locator('form.assistant__compose button')).toHaveCount(1);
  await expect(panel.getByRole('heading', { name: 'Ask about your recordings' })).toHaveCount(0);
  if (engine === 'api') {
    await expect(head.getByText('Session chat', { exact: true })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Search · Session' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'New chat' })).toHaveCount(0);
    await expect(panel.getByText(/Queue/)).toHaveCount(0);
  } else {
    await expect(head.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(head.getByRole('button', { name: /^Search/ })).toHaveCount(0);
  }
  const fits = await head.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits, `${engine} header overflow`).toBe(true);
  await panel.screenshot({ path: path.join(shots, `real-backend-shell-${engine}.png`) });
}

test('the bridge passes Codex routes and the UI reflects what the real backend serves', async () => {
  // A GET that the contract defines as side-effect free; no POST is sent.
  const state = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/codex/state' }));
  // Policy rejections come back as status 0 with "not allowed"; a served or
  // unserved route comes back with a real HTTP status from the backend.
  expect(state.ok ? 200 : state.status).toBeGreaterThan(0);
  if (!state.ok) expect(state.detail).not.toMatch(/not allowed/);
  const blocked = await page.evaluate(() => window.skaz.request({ method: 'POST', path: '/codex/shell', body: {} }));
  expect(blocked).toMatchObject({ ok: false, status: 0 });

  fs.writeFileSync(path.join(shots, 'backend-codex-state.json'),
    JSON.stringify({ ok: state.ok, status: state.ok ? 200 : state.status }, null, 2));

  if (!state.ok && state.status === 404) {
    // Backend without the boundary: the existing assistant stays fully usable.
    await expect(page.getByRole('button', { name: 'Search · Session' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Assistant' }).click();
    await expect(page.getByRole('tab', { name: 'Codex' })).toBeDisabled();
    await page.screenshot({ path: path.join(shots, 'real-backend-codex-unserved.png') });
    await page.locator('.drawer__close').click();
    await expectShell('api');
  } else {
    // Backend serves it: Codex is the first provider tab of Assistant and Notes,
    // and choosing it (without saving) renders the real connection state.
    await page.getByRole('button', { name: 'Settings' }).first().click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('button', { name: 'Codex' })).toHaveCount(0);
    for (const section of ['Assistant', 'Notes']) {
      await nav.getByRole('button', { name: section }).click();
      const tabs = page.getByRole('tablist', { name: `${section} provider` }).getByRole('tab');
      await expect(tabs.first()).toHaveText('Codex');
      await tabs.first().click();
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('codex-connection')).toBeVisible();
      await page.screenshot({ path: path.join(shots, `real-backend-codex-${section.toLowerCase()}.png`) });
    }
    // Nothing saved: closing discards the draft, and no check/login/model route was hit.
    await page.locator('.drawer__close').click();
    const settings = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/codex/state' }));
    expect(settings.ok && (settings.data as { settings: Record<string, unknown> }).settings)
      .toMatchObject({ assistant_enabled: false, notes_enabled: false });
    expect(settings.ok && (settings.data as { connection: { status: string } }).connection.status).toBe('unchecked');
    // Assistant is not on Codex: the API engine answers, in the shared look.
    await expectShell('api');
  }
});

test('independent Codex purpose choices survive saving and renderer reload', async () => {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name: 'Notes' }).click();
  await page.getByRole('tablist', { name: 'Notes provider' }).getByRole('tab', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.drawer__foot').getByText('Saved', { exact: true })).toBeVisible();
  await page.locator('.drawer__close').click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await nav.getByRole('button', { name: 'Notes' }).click();
  await expect(page.getByRole('tablist', { name: 'Notes provider' }).getByRole('tab').first())
    .toHaveAttribute('aria-selected', 'true');
  let state = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/codex/state' }));
  expect(state.ok && (state.data as { settings: Record<string, unknown> }).settings)
    .toMatchObject({ assistant_enabled: false, notes_enabled: true });
  await nav.getByRole('button', { name: 'Assistant' }).click();
  const assistant = page.getByRole('tablist', { name: 'Assistant provider' }).getByRole('tab').first();
  await expect(assistant).toHaveAttribute('aria-selected', 'false');
  await assistant.click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.drawer__foot').getByText('Saved', { exact: true })).toBeVisible();
  await page.locator('.drawer__close').click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await page.reload();
  state = await page.evaluate(() => window.skaz.request({ method: 'GET', path: '/codex/state' }));
  expect(state.ok && (state.data as { settings: Record<string, unknown> }).settings)
    .toMatchObject({ assistant_enabled: true, notes_enabled: true });
  expect(state.ok && (state.data as { connection: { status: string } }).connection.status).toBe('unchecked');
  // Assistant now on Codex: same shell, with its chat picker instead of the API search scope.
  await expectShell('codex');
});

test('Codex assistant markup lays out inside the assistant column (fixture)', async () => {
  test.skip(!fs.existsSync(path.join(dump, 'codex-assistant.html')), 'run the dump test first');
  for (const theme of ['light', 'dark']) {
    for (const name of ['codex-assistant', 'codex-queue', 'codex-picker']) {
      const html = fs.readFileSync(path.join(dump, `${name}.html`), 'utf8');
      await page.evaluate(([markup, t]) => {
        document.documentElement.setAttribute('data-theme', t!);
        let host = document.getElementById('codex-fixture');
        if (!host) {
          host = document.createElement('div');
          host.id = 'codex-fixture';
          host.style.cssText = 'position:fixed;right:0;top:0;width:360px;height:860px;z-index:9999;display:grid;background:var(--paper);';
          document.body.append(host);
        }
        host.innerHTML = markup!;
        // Popovers are placed at runtime by usePanePlacement, which static markup
        // does not run; lay them out in flow so their CONTENT is checked against
        // the 360px column here. Placement inside the column is covered in the
        // real app (panes.smoke + the Codex picker check above).
        host.querySelectorAll<HTMLElement>('.codex-queue__popover, .codex-picker__popover').forEach((el) => {
          el.style.position = 'static';
          el.style.maxWidth = '100%';
        });
      }, [html, theme]);
      await page.waitForTimeout(200);
      const facts = await page.evaluate(() => {
        const scope = document.getElementById('codex-fixture')!;
        const box = scope.getBoundingClientRect();
        const inside = (el: Element | null) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.width > 0;
        };
        const popover = scope.querySelector('.codex-queue__popover, .codex-picker__popover');
        return {
          send: inside(scope.querySelector('.assistant__compose .btn')),
          scope: inside(scope.querySelector('.codex-head__scope')),
          queue: inside(scope.querySelector('.codex-queue__trigger')),
          task: inside(scope.querySelector('.codex-task__status')),
          preview: inside(scope.querySelector('.codex-preview')),
          popover: popover ? inside(popover) : null,
          headOverflow: (() => {
            const head = scope.querySelector('.codex-head')!;
            return head.scrollWidth > head.clientWidth + 1;
          })(),
        };
      });
      expect(facts, `${theme}/${name}`).toMatchObject({ send: true, scope: true, queue: true, task: true, preview: true, headOverflow: false });
      if (name !== 'codex-assistant') expect(facts.popover, `${theme}/${name} popover`).toBe(true);
      await page.locator('#codex-fixture').screenshot({ path: path.join(shots, `${theme}-${name}.png`) });
    }
  }
});
