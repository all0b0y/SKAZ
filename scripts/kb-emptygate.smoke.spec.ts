import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// The accepted empty chat keeps its decorative field and a single usable composer.
// The Vite harness uses a local, synthetic library in Chromium.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_EMPTYGATE_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-emptygate');

interface Box { left: number; top: number; right: number; bottom: number }
interface ComposerAudit { violations: string[]; composer: Box | null }

/** One editable Message field inside the visible chat pane. */
function auditComposer(): ComposerAudit {
  const TOL = 0.5;
  const out: string[] = [];
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const visible = (el: Element) => {
    for (let a: Element | null = el; a; a = a.parentElement) {
      if ((a as HTMLElement).hidden) return false;
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const pane = document.querySelector('[data-pane="center"]');
  if (!pane || !visible(pane)) return { violations: ['the chat pane is not there and visible'], composer: null };
  const P = rect(pane);
  const composers = Array.from(document.querySelectorAll('.kb-composer')).filter(visible);
  if (composers.length !== 1) out.push(`${composers.length} visible composers — a user must have exactly one`);
  const composer = composers[0];
  if (!composer) return { violations: out, composer: null };
  if (!pane.contains(composer)) out.push('the composer is outside the chat pane');
  const CO = rect(composer);
  if (CO.bottom > P.bottom + TOL || CO.top < P.top - TOL
    || CO.left < P.left - TOL || CO.right > P.right + TOL) out.push('the composer leaves the pane');
  if (CO.top < -TOL || CO.bottom > innerHeight + TOL) out.push('the composer is off screen');
  const inputs = Array.from(document.querySelectorAll('[data-testid="message-input"]')).filter(visible);
  if (inputs.length !== 1) out.push(`${inputs.length} visible message fields`);
  const input = inputs[0];
  if (!input) return { violations: out, composer: CO };
  if (!composer.contains(input) || input.getAttribute('role') !== 'textbox'
    || input.getAttribute('aria-label') !== 'Message') out.push('the composer lacks a textbox named Message');
  if (input.getAttribute('contenteditable') !== 'true') out.push('the message field is not editable');
  if (input.getAttribute('aria-readonly') !== null) out.push('the message field is marked read-only');
  return { violations: out, composer: CO };
}

let server: ViteDevServer;
let base = '';
/** Every measured state, for the report a reviewer can read next to the screenshots. */
const gateReports: Array<{ state: string; violations: string[]; composer: Box | null }> = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
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
  if (!address || typeof address !== 'object') throw new Error('No fixture server address');
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(shots, 'gate-report.json'), JSON.stringify(gateReports, null, 1));
  await server?.close();
});

const centre = (page: Page) => page.getByRole('region', { name: 'Chat', exact: true });
const side = (page: Page) => page.getByRole('region', { name: 'Chats' });

async function open(page: Page, theme: 'light' | 'dark', size: { width: number; height: number }, reduced: boolean) {
  await page.setViewportSize(size);
  // Offline only: the fixture origin serves everything; anything else is aborted before it leaves the machine.
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.goto(`${base}/src/kb/test/harness.html`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/src/kb/test/harness.html`);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** All the rendered evidence of one empty state, with the copy's words pinned first. */
async function checkGate(page: Page, state: string) {
  await expect(centre(page)).toBeVisible();
  await expect(centre(page).locator('.kb-chat__plate')).toHaveCount(0);
  await expect(centre(page).getByRole('log', { name: 'Conversation' })).toBeEmpty();
  const stage = centre(page).locator('.kb-chat__stage');
  await expect(stage).toHaveAttribute('data-fx', 'field');
  const canvas = stage.locator('canvas.kb-fx-field');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  const report = await page.evaluate(auditComposer);
  gateReports.push({ state, ...report });
  expect(report.violations, `${state}: one visible and editable composer`).toEqual([]);
}

const chatRow = (page: Page, title: RegExp) => side(page).getByRole('button', { name: title });

/** The composer's own send (not «Resend» of an answer, which the thread can hold). */
const sendButton = (page: Page) => page.getByTestId('composer').getByRole('button', { name: 'Send', exact: true });

/** The composer is live, not painted: typing lands, the send follows the words, clearing restores the hint. */
async function typeAndClear(page: Page, text: string, placeholder: string) {
  const input = page.getByTestId('message-input');
  await expect(input).toHaveAttribute('aria-placeholder', placeholder);
  await expect(sendButton(page)).toHaveCount(0);
  await expect(page.getByTestId('composer').getByRole('button', { name: 'Dictate' })).toBeVisible();
  await input.click();
  await page.keyboard.type(text);
  await expect(input).toHaveText(text);
  await expect(sendButton(page)).toBeEnabled();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await expect(input).toHaveText('');
  await expect(sendButton(page)).toHaveCount(0);
  await expect(page.getByTestId('composer').getByRole('button', { name: 'Dictate' })).toBeVisible();
  await expect(centre(page).locator('.kb-editor__placeholder')).toHaveText(placeholder);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // no hover tooltip or half-faded frame in the picture
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

const VARIANTS = [
  { theme: 'light', size: { width: 1440, height: 860 } },
  { theme: 'dark', size: { width: 1100, height: 760 } },
] as const;

for (const { theme, size } of VARIANTS) {
  const tag = `${theme}-${size.width}`;

  test(`one usable composer in each empty chat — ${tag}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await open(page, theme, size, true);

    // A new chat starts with the field and composer.
    await checkGate(page, `no-chat-${tag}`);
    await typeAndClear(page, 'Try the field', 'Write a message… · @ to reference');
    await shot(page, `no-chat-${tag}`);

    // Switch to an existing empty chat through the sidebar.
    await side(page).getByRole('button', { name: /Compare regularisation/ }).click();
    await checkGate(page, `empty-normal-${tag}`);
    await expect(chatRow(page, /Compare regularisation/)).toHaveAttribute('aria-current', 'page');
    await typeAndClear(page, 'A first question', 'Write a message… · @ to reference');
    await shot(page, `empty-normal-${tag}`);

    // A recording chat exposes the recording-specific composer hint.
    await side(page).getByRole('button', { name: /What did I miss in lecture 8/ }).click();
    await checkGate(page, `empty-recording-${tag}`);
    await expect(chatRow(page, /What did I miss in lecture 8/)).toHaveAttribute('aria-current', 'page');
    await typeAndClear(page, 'About the lecture', 'Ask about the lecture · @ to reference');
    await shot(page, `empty-recording-${tag}`);

    // A chat with messages: the gate is closed — no plate, no canvas — one composer still.
    await side(page).getByRole('button', { name: /Why is there a logarithm/ }).click();
    await expect(centre(page).getByRole('article', { name: 'Answer' })).toBeVisible();
    await expect(page.locator('.kb-chat__plate')).toHaveCount(0);
    await expect(page.locator('canvas.kb-fx-field')).toHaveCount(0);
    await expect(page.locator('.kb-chat__stage')).not.toHaveAttribute('data-fx');
    const thread = await page.evaluate(auditComposer);
    gateReports.push({ state: `thread-${tag}`, violations: thread.violations, composer: thread.composer });
    expect(thread.violations, `thread-${tag}: one usable composer without the empty view`).toEqual([]);
    await expect(chatRow(page, /Why is there a logarithm/)).toHaveAttribute('aria-current', 'page');
    await typeAndClear(page, 'A follow-up', 'Write a message… · @ to reference');
    await shot(page, `thread-${tag}`);

    // Sidebar switches restore each chat's empty or populated state.
    await chatRow(page, /Compare regularisation/).click();
    await checkGate(page, `switch-normal-${tag}`);
    await chatRow(page, /What did I miss in lecture 8/).click();
    await checkGate(page, `switch-recording-${tag}`);
    await chatRow(page, /Why is there a logarithm/).click();
    await expect(centre(page).getByRole('article', { name: 'Answer' })).toBeVisible();
    await expect(page.locator('.kb-chat__plate')).toHaveCount(0);
    // Starting a new chat leaves the existing chat accessible from the sidebar.
    await side(page).getByRole('button', { name: 'New chat' }).click();
    await checkGate(page, `switch-new-chat-${tag}`);
    await expect(chatRow(page, /Why is there a logarithm/)).not.toHaveAttribute('aria-current', 'page');
    await shot(page, `switch-new-chat-${tag}`);

    expect(errors, 'console or page errors during the journey').toEqual([]);
  });
}

test('a question sent from the empty view closes the gate for real (motion on)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await open(page, 'light', { width: 1440, height: 860 }, false);

  // The same rendered gate with animations on: the layout is not a reduced-motion artefact.
  await checkGate(page, 'full-motion-no-chat');
  const input = page.getByTestId('message-input');
  await input.click();
  await page.keyboard.type('What is entropy?');
  await expect(input).toHaveText('What is entropy?');
  await page.keyboard.press('Enter');

  // Sending the first question replaces the empty view with the conversation.
  await expect(centre(page).getByRole('article', { name: 'Your question' })).toBeVisible();
  await expect(page.locator('.kb-chat__plate')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('canvas.kb-fx-field')).toHaveCount(0);
  await expect(page.locator('.kb-chat__stage')).not.toHaveAttribute('data-fx');
  const after = await page.evaluate(auditComposer);
  gateReports.push({ state: 'full-motion-after-send', violations: after.violations, composer: after.composer });
  expect(after.violations, 'after the send: still one usable composer').toEqual([]);
  await expect(input).toHaveText('');

  await expect(chatRow(page, /What is entropy\?/)).toHaveAttribute('aria-current', 'page');

  // And the field is ready for the next question while the answer is on its way.
  await input.click();
  await page.keyboard.type('And in plain words?');
  await expect(input).toHaveText('And in plain words?');
  await shot(page, 'full-motion-after-send');
  expect(errors, 'console or page errors during the send').toEqual([]);
});
