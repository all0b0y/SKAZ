import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Panels in the built Electron shell: toggles, real mouse drag, collapse,
// narrow-window auto-close and overlay (docs/PANELS-AND-NOTES-SOURCE-SPEC.md).
// UI chrome only — no ASR, no model calls.

const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'panels');

let app: ElectronApplication;
let page: Page;

const slot = (id: 'sessions' | 'assistant') => page.locator(`.panel-slot[data-panel="${id}"]`);
const boxWidth = async (id: 'sessions' | 'assistant') => (await slot(id).boundingBox())?.width ?? 0;

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  // Isolated profile through the wrapper that proves userData/sessionData/documents
  // were relocated before main.js loads. Launching main.js directly would drive
  // the user's real profile (there is no env override for userData there).
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-panels-')));
  app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: userData, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 820 });
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
    { timeout: 60_000 }).toBe('ready');
  // Isolated onboarding preference only (as storage-root.smoke): no credentials or consent.
  await page.evaluate(async () => {
    const response = await window.skaz.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
    if (!response.ok) throw new Error('Fixture onboarding failed');
  });
  await page.reload();
  await expect(page.locator('.onboarding')).toHaveCount(0);
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('panels toggle, drag, collapse and fit the window', async () => {
  test.setTimeout(120_000);
  await expect(slot('sessions')).toHaveAttribute('data-state', 'docked');
  await expect(slot('assistant')).toHaveAttribute('data-state', 'docked');
  await page.screenshot({ path: path.join(shots, '01-default.png') });

  // The assistant's content fits its panel: the send button is not clipped off the window.
  const fits = async () => {
    const send = (await page.getByRole('button', { name: 'Send question' }).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(send.x + send.width).toBeLessThanOrEqual(viewport.width);
  };
  await fits();

  // Robot toggle hides and shows the assistant.
  await page.getByRole('button', { name: 'Hide assistant' }).click();
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'closed');
  expect(await boxWidth('assistant')).toBeLessThan(2);
  await page.screenshot({ path: path.join(shots, '02-assistant-hidden.png') });
  await page.getByRole('button', { name: 'Show assistant' }).click();
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'docked');

  // Sessions toggle: the titlebar gains New session + Settings while it is hidden.
  await page.getByRole('button', { name: 'Hide sessions panel' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.titlebar').getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(page.locator('.titlebar').getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.screenshot({ path: path.join(shots, '03-sessions-hidden.png') });
  await page.keyboard.press('Meta+Slash');
  await page.waitForTimeout(400);
  await expect(slot('sessions')).toHaveAttribute('data-state', 'docked');

  // Real mouse drag on the sessions border.
  const before = await boxWidth('sessions');
  const handle = page.getByRole('separator', { name: 'Sessions panel width' });
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
  await page.screenshot({ path: path.join(shots, '04-border-hover.png') });
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + 200, { steps: 6 });
  await page.screenshot({ path: path.join(shots, '05-dragging.png') });
  // Only the border being dragged lights up.
  await expect(page.locator('.panel-resizer--active')).toHaveCount(1);
  await expect(page.locator('.panel-resizer--active')).toHaveAttribute('aria-label', 'Sessions panel width');
  await page.mouse.up();
  expect(Math.round(await boxWidth('sessions'))).toBe(Math.round(before + 60));

  // Dragging the assistant border far right collapses it.
  const ah = (await page.getByRole('separator', { name: 'Assistant panel width' }).boundingBox())!;
  await page.mouse.move(ah.x + ah.width / 2, ah.y + 200);
  await page.mouse.down();
  await page.mouse.move(ah.x + 400, ah.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByRole('button', { name: 'Show assistant' })).toBeVisible();
  await page.keyboard.press('Meta+Period');
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'docked');

  // Narrow window: assistant auto-closes; explicit open floats it.
  await page.setViewportSize({ width: 820, height: 820 });
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'closed');
  await page.screenshot({ path: path.join(shots, '06-narrow.png') });
  await page.getByRole('button', { name: 'Show assistant' }).click();
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'overlay');
  await page.screenshot({ path: path.join(shots, '07-narrow-overlay.png') });
  await fits();
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.waitForTimeout(400);
  await expect(slot('assistant')).toHaveAttribute('data-state', 'docked');

  // Layout survives a reload.
  const remembered = Math.round(await boxWidth('sessions'));
  await page.reload();
  await page.waitForTimeout(4000);
  expect(Math.round(await boxWidth('sessions'))).toBe(remembered);
  await page.screenshot({ path: path.join(shots, '08-after-reload.png') });
});

test('the recorder belongs to the transcript column at every width and drag', async () => {
  test.setTimeout(120_000);
  // A session with a stored recorder error gives the widest capsule content.
  await page.getByRole('button', { name: 'New session' }).first().click();
  await expect(page.locator('.capsule')).toBeVisible();
  // The reported case: a long recorder error inside the capsule. Injected as the
  // same markup CapsuleError renders (no microphone or failing backend needed).
  await page.evaluate(() => {
    const capsule = document.querySelector('.capsule')!;
    capsule.classList.add('capsule--error');
    capsule.insertAdjacentHTML('beforeend', '<div class="capsule__error" role="alert" data-fixture="1">'
      + '<button type="button" class="capsule__error-text">Confirm the previous backend lifecycle state before recording again.</button>'
      + '<button type="button" class="capsule__error-action"><span class="capsule__error-action-label">Retry stop confirmation</span></button>'
      + '<button type="button" class="capsule__error-close" aria-label="Dismiss error">×</button></div>');
  });
  const check = async (label: string) => {
    await page.waitForTimeout(350);
    const box = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
      const center = r('.workspace > .center')!;
      const capsule = r('.capsule')!;
      const recorder = r('.recorder')!;
      const assistant = document.querySelector('.panel-slot[data-panel="assistant"][data-state="docked"]')?.getBoundingClientRect() ?? null;
      return { center, capsule, recorder, assistant, viewport: window.innerWidth };
    });
    expect(box.recorder.left, `${label}: recorder starts inside the column`).toBeGreaterThanOrEqual(box.center.left - 0.5);
    expect(box.recorder.right, `${label}: recorder ends inside the column`).toBeLessThanOrEqual(box.center.right + 0.5);
    expect(box.capsule.right, `${label}: capsule inside the column`).toBeLessThanOrEqual(box.center.right + 0.5);
    expect(box.capsule.left, `${label}: capsule inside the column`).toBeGreaterThanOrEqual(box.center.left - 0.5);
    expect(Math.abs((box.capsule.left + box.capsule.right) / 2 - (box.center.left + box.center.right) / 2), `${label}: centred`).toBeLessThan(2);
    if (box.assistant) expect(box.center.right, `${label}: centre ends where the assistant starts`).toBeLessThanOrEqual(box.assistant.left + 0.5);
    expect(box.center.right, `${label}: within the window`).toBeLessThanOrEqual(box.viewport + 0.5);
  };
  for (const width of [1400, 1100, 900, 820]) {
    await page.setViewportSize({ width, height: 820 });
    await check(`window ${width}`);
  }
  await page.setViewportSize({ width: 1400, height: 820 });
  const handle = page.getByRole('separator', { name: 'Sessions panel width' });
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 360, hb.y + 200, { steps: 8 });
  await page.mouse.up();
  await check('sessions dragged wide');
  await page.screenshot({ path: path.join(shots, '09-recorder-narrow-centre.png') });
});
