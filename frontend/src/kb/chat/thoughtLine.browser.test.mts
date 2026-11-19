import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import type { FakeWorld } from '../test/fakeKb';

declare global {
  interface Window { __kbFake: { world: FakeWorld } }
}

let server: ViteDevServer;
let browser: Browser;
let origin: string;

before(async () => {
  server = await createServer({
    configFile: false, envFile: false, root: resolve('frontend'),
    cacheDir: resolve('.dev/vite-cache/thought-line'),
    resolve: { alias: { '@': resolve('frontend/src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openChat(t: TestContext, longHistory = false, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion });
  const errors: string[] = [];
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push('External request: ' + route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem('skaz.kb.prefs', JSON.stringify({ motion: 'full' })));
  await page.goto(origin + '/src/kb/test/harness.html');
  const choice = page.getByRole('button', { name: /Why is there a logarithm/ });
  await choice.waitFor();
  await page.evaluate((long) => {
    const chat = window.__kbFake.world.chats.find((c) => c.id === 'c1')!;
    const [question, answer] = chat.messages;
    chat.messages = Array.from({ length: long ? 18 : 1 }, (_, i) => ({ ...question!, id: 'q' + i, seq: i + 1 }));
    chat.messages.push({
      ...answer!, seq: chat.messages.length + 1, state: 'streaming',
      parts: Array.from({ length: 18 }, (_, i) => ({
        type: 'tool', name: 'skaz_search', label: 'Search sample ' + (i + 1), status: 'done',
      })),
    });
    chat.state = 'answering';
    window.__kbFake.world.chatEvents.c1 = [];
  }, longHistory);
  await choice.click();
  const trigger = page.getByRole('button', { name: /13 earlier/ });
  await expect(trigger).toBeVisible();
  const log = page.getByRole('log', { name: 'Conversation' });
  // Let the tab-switch entrance finish before measuring the row in viewport coordinates.
  await log.evaluate((el) => Promise.allSettled(el.getAnimations().map((a) => a.finished)).then(() => {}));
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  return { page, trigger, log, composer };
}

async function append(page: Page, kind: 'tool' | 'text') {
  await page.evaluate((kind) => {
    const { world } = window.__kbFake;
    const chat = world.chats.find((c) => c.id === 'c1')!;
    const event = { seq: ++chat.cursor, message_id: chat.messages.at(-1)!.id };
    world.chatEvents.c1!.push(kind === 'tool'
      ? { ...event, type: 'part', part: { type: 'tool', name: 'skaz_search', label: 'Search sample 19', status: 'done' } }
      : { ...event, type: 'delta', text: 'A streamed paragraph.\n\n'.repeat(12) });
  }, kind);
}

test('hover holds the trigger under the pointer at the bottom, including during a tool arrival', async (t) => {
  const { page, log, trigger } = await openChat(t, true);
  const position = () => log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight }));
  const before = await position();
  assert.ok(before.top > 300 && before.height - before.view - before.top <= 1);
  const rect = await trigger.boundingBox();
  assert.ok(rect);
  const pointer = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  const fold = page.locator('.kb-thought__earlier-fold');
  await expect(fold).toHaveCSS('opacity', '1');
  await expect.poll(async () => (await position()).height).toBeGreaterThan(before.height + 25);
  const verifyAnchor = async () => {
    const box = await page.locator('.kb-thought__earlier-trigger').boundingBox();
    assert.ok(box);
    const after = await position();
    t.diagnostic(JSON.stringify({ before, after, triggerBefore: rect.y, triggerAfter: box.y }));
    assert.ok(Math.abs(box.y - rect.y) <= 1 && Math.abs(box.x - rect.x) <= 1);
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('.kb-thought__earlier-trigger'), pointer), true);
    assert.equal(after.top, before.top);
  };
  await verifyAnchor();
  await append(page, 'tool');
  await expect(page.getByRole('button', { name: /14 earlier/ })).toHaveAttribute('aria-expanded', 'true');
  await verifyAnchor();
  await page.mouse.move(0, 0);
  await expect(fold).toHaveCSS('opacity', '0');
  await log.evaluate((el) => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Return to the latest message' }).click();
  const gap = async () => { const p = await position(); return p.height - p.top - p.view; };
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await append(page, 'text');
  await expect(log.getByText(/A streamed paragraph/).last()).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(1);
});

test('a sticky chat keeps the last reply visible as a six-line draft and a smaller window shrink the log', async (t) => {
  const { page, log, composer } = await openChat(t, true);
  await append(page, 'text');
  const lastLine = log.getByText('A streamed paragraph.', { exact: true }).last();
  const height = () => log.evaluate((el) => el.clientHeight);
  const gap = () => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  const expectSticky = async () => {
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await expect(lastLine).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Return to the latest message' })).toHaveCount(0);
  };
  await expect(lastLine).toBeVisible();
  await expectSticky();
  const initialHeight = await height();
  await composer.focus();
  await page.keyboard.insertText('one\ntwo\nthree\nfour\nfive\nsix');
  await expect.poll(height).toBeLessThan(initialHeight);
  await expectSticky();
  const draftHeight = await height();
  await page.setViewportSize({ width: 1200, height: 570 });
  await expect.poll(height).toBeLessThan(draftHeight);
  await expectSticky();
});

test('resizing leaves a reader who scrolled up at their reading position', async (t) => {
  const { page, log } = await openChat(t, true);
  await log.hover();
  await page.mouse.wheel(0, -480);
  await expect(page.getByRole('button', { name: 'Return to the latest message' })).toBeVisible();
  const top = await log.evaluate((el) => el.scrollTop);
  const height = await log.evaluate((el) => el.clientHeight);
  await page.setViewportSize({ width: 1200, height: 570 });
  await expect.poll(() => log.evaluate((el) => el.clientHeight)).toBeLessThan(height);
  // Allow the resize observer and its React layout effect to run before checking the reading position.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await log.evaluate((el) => el.scrollTop), top);
});

test('Escape dismisses hovered calls with focus still in the composer', async (t) => {
  const { page, trigger, composer } = await openChat(t);
  await composer.fill('Retained draft');
  await trigger.hover();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('Retained draft');
});

test('Find owns Escape when its input is focused over a hover disclosure', async (t) => {
  const { page, trigger, composer } = await openChat(t);
  await composer.press('Control+f');
  const find = page.getByRole('textbox', { name: 'Text to find in this chat' });
  await expect(find).toBeFocused();
  await trigger.hover();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Search', exact: true }).press('Enter');
  const modal = page.getByRole('dialog', { name: 'Search' });
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(find).toBeVisible();
  await find.focus();
  await trigger.hover();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(composer).toBeFocused();
});

test('a mounted full-motion answer follows live media preference changes on each reveal', async (t) => {
  const { page, trigger } = await openChat(t);
  const chip = page.locator('.kb-thought__earlier-list > li').nth(1);
  for (const preference of ['no-preference', 'reduce', 'no-preference'] as const) {
    await page.emulateMedia({ reducedMotion: preference });
    await trigger.hover();
    await expect(chip).toHaveCSS('animation-name', preference === 'reduce' ? 'none' : 'kb-early-chip-in');
    await expect(chip).toHaveCSS('animation-delay', preference === 'reduce' ? '0s' : '0.04s');
    if (preference === 'reduce') await expect(page.locator('.kb-thought__earlier-fold')).toHaveCSS('transition-property', 'opacity');
    await page.mouse.move(0, 0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});

test('enabling full motion after mounting with reduced motion restores the chip entrance', async (t) => {
  const { page, trigger } = await openChat(t, false, 'reduce');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger.hover();
  const chip = page.locator('.kb-thought__earlier-list > li').nth(1);
  await expect(chip).toHaveCSS('animation-name', 'kb-early-chip-in');
  await expect(chip).toHaveCSS('animation-delay', '0.04s');
});

test('releasing outside an already focused trigger permits the next keyboard focus reveal', async (t) => {
  const { page, trigger } = await openChat(t);
  await trigger.focus();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await trigger.hover();
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.keyboard.press('Tab');
  await expect(trigger).not.toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
