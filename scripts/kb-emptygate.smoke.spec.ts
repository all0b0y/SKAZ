import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

// R041 B2 — the empty chat's copy above the message field, in a real Chromium window.
//
// emptyField.test.tsx:59 used to hold the plate and the composer as DOM siblings; the 0.4.1 chat
// tabs put a workspace wrapper around the stage and the plate, so the jsdom test now pins the same
// reading order across that wrapper. What jsdom cannot show a reviewer is checked here: the copy an
// actual user gets, rendered — visible, above ONE usable composer, in the same visible chat pane —
// for no chat at all, an empty normal chat tab, an empty recording chat tab, and across tab
// switches; the canvas stays decorative, the copy is met before the field in the accessibility
// tree, and the rendered boxes overlap nothing and leave neither the pane nor the window.
//
// The local offline harness only: Vite serves frontend/src/kb/test/harness.html on 127.0.0.1 over
// the shared fake backend (the chatWorld fixtures — synthetic data). No Electron, no profile, no
// microphone, no provider, nothing off the fixture origin. Layout and behaviour, not model quality.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_EMPTYGATE_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-emptygate');

/** The plate's two lines, as ChatView writes them for each empty state. */
const COPY = {
  newChat: {
    title: 'Ask about your materials',
    text: 'Answers cite the exact moments of your recordings and the pages of your documents. Type @ to point at a page, a material or a chat.',
  },
  normal: {
    title: 'No messages yet',
    text: 'Ask about your materials. Type @ to point at a page, a material or a chat.',
  },
  recording: {
    title: 'Ask about the lecture',
    text: 'Questions here are answered from what has been recognised so far. Type @ to point at a page or a material.',
  },
} as const;

interface Box { left: number; top: number; right: number; bottom: number }
interface GateAudit { violations: string[]; pane: Box | null; stage: Box | null; plate: Box | null; composer: Box | null }
interface ComposerAudit { violations: string[]; composer: Box | null }

/** The empty view as a user gets it, measured in the rendered page. Self-contained: Playwright
 *  serialises this into the page, so it may close over nothing. */
function auditGate(expected: { title: string; text: string }): GateAudit {
  const TOL = 0.5;
  const out: string[] = [];
  const bad = (why: string) => out.push(why);
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
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
  if (!pane || !visible(pane)) return { violations: ['the chat pane is not there and visible'], pane: null, stage: null, plate: null, composer: null };
  const P = rect(pane);
  if (P.top < -TOL || P.bottom > innerHeight + TOL) bad(`the chat pane is not fully on screen: ${JSON.stringify(P)}`);

  // One copy plate, exposed, settled, saying this state's words.
  const plates = Array.from(document.querySelectorAll('.kb-chat__plate')).filter(visible);
  if (plates.length !== 1) {
    bad(`${plates.length} visible copy plates — a user must see exactly one`);
    return { violations: out, pane: P, stage: null, plate: null, composer: null };
  }
  const plate = plates[0]!;
  if (plate.getAttribute('aria-hidden') !== null) bad('the copy plate is aria-hidden: lost to assistive technology');
  if (plate.hasAttribute('data-leaving')) bad('the copy plate is mid-leave; the empty view should be settled here');
  const titleEl = plate.querySelector('.kb-chat__plate-title');
  const textEl = plate.querySelector('.kb-chat__plate-text');
  if (titleEl?.textContent !== expected.title) bad(`the plate title reads ${JSON.stringify(titleEl?.textContent ?? null)}`);
  if (textEl?.textContent !== expected.text) bad(`the plate text reads ${JSON.stringify(textEl?.textContent ?? null)}`);
  const PL = rect(plate);

  // The field is decorative: on the stage, hidden from assistive technology, no copy on it.
  const stage = pane.querySelector('.kb-chat__stage');
  if (!stage) return { violations: [...out, 'no stage in the chat pane'], pane: P, stage: null, plate: PL, composer: null };
  const ST = rect(stage);
  if (stage.getAttribute('data-fx') !== 'field') bad(`the stage is not the empty field (data-fx=${JSON.stringify(stage.getAttribute('data-fx'))})`);
  const canvases = Array.from(pane.querySelectorAll('canvas.kb-fx-field')).filter(visible);
  if (canvases.length !== 1) bad(`${canvases.length} visible field canvases`);
  if (canvases[0] && canvases[0].getAttribute('aria-hidden') !== 'true') bad('the field canvas is not aria-hidden');
  if (stage.contains(plate)) bad('the copy plate sits on the canvas stage');
  const log = pane.querySelector('[role="log"]');
  if (!log) bad('no conversation log in the pane');
  else {
    if (log.childElementCount !== 0) bad(`the log holds ${log.childElementCount} nodes over the empty field`);
    if (log.contains(plate)) bad('the copy plate is inside the conversation log');
  }

  // Reading order in the DOM: the copy ends the workspace, the composer with the field follows it.
  const workspace = plate.closest('.kb-chat__workspace');
  if (!workspace) bad('the copy plate is not in the workspace');
  else {
    if (workspace.parentElement !== pane) bad('the workspace is not a child of the chat pane');
    if (plate.parentElement !== workspace) bad('the copy plate is not a direct child of the workspace');
    if (plate.nextElementSibling !== null) bad(`the workspace does not end with the copy: "${plate.nextElementSibling.className}" follows it`);
  }

  // One composer, in the same pane, editable, named.
  const composers = Array.from(document.querySelectorAll('.kb-composer')).filter(visible);
  if (composers.length !== 1) bad(`${composers.length} visible composers — a user must have exactly one`);
  const composer = composers[0];
  if (!composer) return { violations: out, pane: P, stage: ST, plate: PL, composer: null };
  const CO = rect(composer);
  if (!pane.contains(composer)) bad('the composer is outside the chat pane');
  const inputs = Array.from(document.querySelectorAll('[data-testid="message-input"]')).filter(visible);
  if (inputs.length !== 1) bad(`${inputs.length} visible message fields`);
  const input = inputs[0]!;
  if (!composer.contains(input)) bad('the message field is not inside the composer');
  if (workspace) {
    if (!(workspace.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)) bad('the copy does not precede the field in document order');
    if (workspace.nextElementSibling !== composer) bad('the composer does not follow the workspace directly');
  }
  if (input.getAttribute('contenteditable') !== 'true') bad('the message field is not editable');
  if (input.getAttribute('aria-readonly') !== null) bad('the message field is marked read-only');
  if (input.getAttribute('role') !== 'textbox' || input.getAttribute('aria-label') !== 'Message') bad('the message field is not a textbox named "Message"');

  // The rendered picture: the copy above the composer, nothing overlapping, nothing out of view.
  const header = pane.querySelector('.kb-head--chat');
  if (header) {
    const H = rect(header);
    if (PL.top < H.bottom - TOL) bad(`the copy rides over the header (${PL.top} < ${H.bottom})`);
  }
  if (PL.bottom > CO.top + TOL) bad(`the copy overlaps the composer (plate bottom ${PL.bottom} > composer top ${CO.top})`);
  if (PL.top < ST.bottom - TOL) bad(`the copy rides over the canvas (plate top ${PL.top} < stage bottom ${ST.bottom})`);
  if (PL.left < P.left - 1 || PL.right > P.right + 1) bad('the copy spills the pane horizontally');
  if (CO.left < P.left - 1 || CO.right > P.right + 1) bad('the composer spills the pane horizontally');
  if (CO.top < P.top - TOL || CO.bottom > P.bottom + TOL) bad('the composer leaves the pane');
  if (PL.top < -TOL || PL.bottom > innerHeight + TOL) bad('the copy is off screen');
  if (CO.top < -TOL || CO.bottom > innerHeight + TOL) bad('the composer is off screen');

  // The words themselves: every line rendered, in view, not cut away by any clipping box.
  for (const p of [titleEl, textEl]) {
    if (!p || !visible(p)) { bad('a copy line is not rendered'); continue; }
    const r = rect(p);
    let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
    for (let a: Element | null = p.parentElement; a && a !== pane; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ar = rect(a);
      if (cs.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
      if (cs.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
    }
    if (right - left <= 0 || bottom - top <= 0) bad(`a copy line is clipped away entirely (${p.className})`);
    const range = document.createRange();
    range.selectNodeContents(p);
    const lines = Array.from(range.getClientRects()).filter((l) => l.width > 0 && l.height > 0);
    if (lines.length === 0) bad(`no rendered text lines (${p.className})`);
    for (const l of lines) {
      if (l.top < -TOL || l.bottom > innerHeight + TOL || l.left < P.left - 1 || l.right > P.right + 1) {
        bad(`a copy line is out of view: ${JSON.stringify({ top: l.top, bottom: l.bottom, left: l.left, right: l.right })}`);
      }
    }
  }
  return { violations: out, pane: P, stage: ST, plate: PL, composer: CO };
}

/** A chat with messages: no plate, no field — but still one usable composer in the pane. */
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
  if (CO.bottom > P.bottom + TOL || CO.top < P.top - TOL) out.push('the composer leaves the pane');
  if (CO.top < -TOL || CO.bottom > innerHeight + TOL) out.push('the composer is off screen');
  const inputs = Array.from(document.querySelectorAll('[data-testid="message-input"]')).filter(visible);
  if (inputs.length !== 1) out.push(`${inputs.length} visible message fields`);
  const input = inputs[0]!;
  if (input.getAttribute('contenteditable') !== 'true') out.push('the message field is not editable');
  if (input.getAttribute('aria-readonly') !== null) out.push('the message field is marked read-only');
  return { violations: out, composer: CO };
}

let server: ViteDevServer;
let base = '';
/** Every measured state, for the report a reviewer can read next to the screenshots. */
const gateReports: Array<{ state: string; violations: string[]; pane: Box | null; stage?: Box | null; plate?: Box | null; composer: Box | null }> = [];

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
async function checkGate(page: Page, state: string, copy: { title: string; text: string }) {
  await expect(centre(page)).toBeVisible();
  await expect(centre(page).locator('.kb-chat__plate-title')).toHaveText(copy.title);
  const report = await page.evaluate(auditGate, copy);
  gateReports.push({ state, violations: report.violations, pane: report.pane, stage: report.stage, plate: report.plate, composer: report.composer });
  expect(report.violations, `${state}: the empty view a user actually gets`).toEqual([]);
  // Reading order in the accessibility tree too: the copy is exposed, and met before the field.
  const snap = await centre(page).ariaSnapshot();
  const atCopy = snap.indexOf(copy.title);
  const atField = snap.indexOf('textbox "Message"');
  expect(atCopy, `${state}: the copy is not in the accessibility tree`).toBeGreaterThanOrEqual(0);
  expect(atField, `${state}: the message field is not in the accessibility tree`).toBeGreaterThanOrEqual(0);
  expect(atCopy, `${state}: the copy must be met before the field`).toBeLessThan(atField);
  return report;
}

/** The composer's own send (not «Resend» of an answer, which the thread can hold). */
const sendButton = (page: Page) => page.getByTestId('composer').getByRole('button', { name: 'Send', exact: true });

/** The composer is live, not painted: typing lands, the send follows the words, clearing restores the hint. */
async function typeAndClear(page: Page, text: string, placeholder: string) {
  const input = page.getByTestId('message-input');
  await expect(input).toHaveAttribute('aria-placeholder', placeholder);
  await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true');
  await input.click();
  await page.keyboard.type(text);
  await expect(input).toHaveText(text);
  await expect(sendButton(page)).not.toHaveAttribute('aria-disabled');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await expect(input).toHaveText('');
  await expect(sendButton(page)).toHaveAttribute('aria-disabled', 'true');
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

  test(`the empty copy above one usable composer — ${tag}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await open(page, theme, size, true);

    // No chat at all: the new-chat copy over the field.
    await checkGate(page, `no-chat-${tag}`, COPY.newChat);
    await typeAndClear(page, 'Try the field', 'Ask about your materials · @ to reference');
    await shot(page, `no-chat-${tag}`);

    // An empty chat that is not a recording, opened as a tab from the list.
    await side(page).getByRole('button', { name: /Compare regularisation/ }).click();
    await checkGate(page, `empty-normal-${tag}`, COPY.normal);
    const strip = page.getByRole('tablist', { name: 'Open chats' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('tab')).toHaveCount(1);
    await expect(strip.getByRole('tab', { name: /Compare regularisation/ })).toHaveAttribute('aria-selected', 'true');
    await typeAndClear(page, 'A first question', 'Ask about your materials · @ to reference');
    await shot(page, `empty-normal-${tag}`);

    // An empty chat a recording opened: its own copy, its own placeholder, the «during recording» tag.
    await side(page).getByRole('button', { name: /What did I miss in lecture 8/ }).click();
    await checkGate(page, `empty-recording-${tag}`, COPY.recording);
    await expect(centre(page).locator('.kb-tag--static')).toHaveText('during recording');
    await expect(strip.getByRole('tab')).toHaveCount(2);
    await expect(strip.getByRole('tab', { name: /What did I miss in lecture 8/ })).toHaveAttribute('aria-selected', 'true');
    await typeAndClear(page, 'About the lecture', 'Ask about the lecture · @ to reference');
    await shot(page, `empty-recording-${tag}`);

    // A chat with messages: the gate is closed — no plate, no canvas — one composer still.
    await side(page).getByRole('button', { name: /Why is there a logarithm/ }).click();
    await expect(centre(page).getByRole('article', { name: 'Answer' })).toBeVisible();
    await expect(page.locator('.kb-chat__plate')).toHaveCount(0);
    await expect(page.locator('canvas.kb-fx-field')).toHaveCount(0);
    await expect(page.locator('.kb-chat__stage')).not.toHaveAttribute('data-fx');
    const thread = await page.evaluate(auditComposer);
    gateReports.push({ state: `thread-${tag}`, violations: thread.violations, pane: null, composer: thread.composer });
    expect(thread.violations, `thread-${tag}: one usable composer without the empty view`).toEqual([]);
    await expect(strip.getByRole('tab')).toHaveCount(3);
    await expect(strip.getByRole('tab', { name: /Why is there a logarithm/ })).toHaveAttribute('aria-selected', 'true');
    await typeAndClear(page, 'A follow-up', 'Ask about your materials · @ to reference');
    await shot(page, `thread-${tag}`);

    // Tab switches: the strip drives the same pane, and each state gets its copy back.
    await strip.getByRole('tab', { name: /Compare regularisation/ }).click();
    await checkGate(page, `switch-normal-${tag}`, COPY.normal);
    await strip.getByRole('tab', { name: /What did I miss in lecture 8/ }).click();
    await checkGate(page, `switch-recording-${tag}`, COPY.recording);
    await strip.getByRole('tab', { name: /Why is there a logarithm/ }).click();
    await expect(centre(page).getByRole('article', { name: 'Answer' })).toBeVisible();
    await expect(page.locator('.kb-chat__plate')).toHaveCount(0);
    // And back to a new chat with the tabs still open: the strip keeps them, none is selected.
    await side(page).getByRole('button', { name: 'New chat' }).click();
    await checkGate(page, `switch-new-chat-${tag}`, COPY.newChat);
    for (const tab of await strip.getByRole('tab').all()) await expect(tab).toHaveAttribute('aria-selected', 'false');
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
  await checkGate(page, 'full-motion-no-chat', COPY.newChat);
  const input = page.getByTestId('message-input');
  await input.click();
  await page.keyboard.type('What is entropy?');
  await expect(input).toHaveText('What is entropy?');
  await page.keyboard.press('Enter');

  // The question lands where the copy was, and the burn-out (≤ 700 ms) ends the empty view.
  await expect(centre(page).getByRole('article', { name: 'Your question' })).toBeVisible();
  await expect(page.locator('.kb-chat__plate')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('canvas.kb-fx-field')).toHaveCount(0);
  await expect(page.locator('.kb-chat__stage')).not.toHaveAttribute('data-fx');
  const after = await page.evaluate(auditComposer);
  gateReports.push({ state: 'full-motion-after-send', violations: after.violations, pane: null, composer: after.composer });
  expect(after.violations, 'after the send: still one usable composer').toEqual([]);
  await expect(input).toHaveText('');

  // The send created the chat and its tab: one tab, the new chat's, selected and named by the question.
  const strip = page.getByRole('tablist', { name: 'Open chats' });
  await expect(strip.getByRole('tab')).toHaveCount(1);
  await expect(strip.getByRole('tab', { name: /What is entropy\?/ })).toHaveAttribute('aria-selected', 'true');

  // And the field is ready for the next question while the answer is on its way.
  await input.click();
  await page.keyboard.type('And in plain words?');
  await expect(input).toHaveText('And in plain words?');
  await shot(page, 'full-motion-after-send');
  expect(errors, 'console or page errors during the send').toEqual([]);
});
