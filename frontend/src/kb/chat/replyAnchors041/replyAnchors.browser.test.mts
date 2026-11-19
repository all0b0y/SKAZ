import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { build, type OutputFile } from 'esbuild';
import { expect } from '@playwright/test';
import { chromium, type Browser, type Locator } from 'playwright';
import type { KbServices } from '../../state/context';
import type { FakeWorld } from '../../test/fakeKb';

type Host = Window & {
  __kbFake: { world: FakeWorld; services: KbServices };
  settleSend: (accepted: boolean) => void;
};
type StreamingHost = Host & {
  deliverGrowth?: () => void;
  returnLanding?: { initialHeight: number; heightAtEnd: number; topAtEnd: number };
};
let browser: Browser;
let bundle: OutputFile[];
before(async () => {
  const result = await build({
    entryPoints: ['frontend/src/kb/test/harness.tsx'], outfile: 'host.js', bundle: true,
    write: false, format: 'iife', jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wav': 'dataurl' },
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

async function openThread(t: TestContext, motion: 'full' | 'off' = 'off', streaming = false) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, reducedMotion: 'no-preference' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  const origin = 'http://fixture.invalid';
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><div id="root"></div><script src="/host.js"></script>' });
      const file = bundle.find((item) => item.path.endsWith(url.pathname));
      if (file) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: file.text });
    }
    errors.push(url.href);
    return route.abort();
  });
  await page.addInitScript((level) => localStorage.setItem('skaz.kb.prefs', JSON.stringify({ motion: level })), motion);
  await page.goto(origin + '/?hold=1');
  const open = page.getByRole('button', { name: /Why is there a logarithm/ });
  await open.waitFor();
  await page.evaluate((stream) => {
    const chat = (window as unknown as Host).__kbFake.world.chats.find((c) => c.id === 'c1')!;
    const template = chat.messages.find((m) => m.role === 'assistant')!;
    const paragraph = 'A synthetic answer for reading and navigation. '.repeat(22);
    chat.messages = Array.from({ length: 5 }, (_, i) => ({
      ...template, id: 'reply-' + i, seq: i + 1, state: stream && i === 4 ? 'streaming' : template.state, parts: [{ type: 'text', text:
        paragraph + '\n\n' + (i === 1 ? 'Needle one. ' : '') + paragraph.repeat(i === 1 ? 4 : 1) + '\n\n' + (i === 1 ? 'Needle two. ' : '') + paragraph }],
    }));
    if (stream) chat.state = 'answering';
  }, streaming);
  await open.click();
  const log = page.getByRole('log', { name: 'Conversation' });
  const markers = page.getByRole('navigation', { name: 'Answers in this chat' }).getByRole('button');
  await expect(markers).toHaveCount(5);
  await log.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(markers.last()).toHaveAttribute('aria-current', 'true');
  return { page, log, markers, latest: page.getByRole('button', { name: 'Return to the latest message' }) };
}

const gap = (log: Locator) => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test('a full-motion marker jump lands in history and Return resumes bottom follow', async (t) => {
  const { log, markers, latest } = await openThread(t, 'full');
  const target = log.locator('[data-message-id="reply-1"]');
  const initial = await log.evaluate((el) => el.scrollTop);
  const destination = await target.evaluate((el) => {
    const scroller = el.closest('[role="log"]')!;
    return scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 75;
  });
  assert.ok(initial > destination + 500);
  await markers.nth(1).click();
  await expect.poll(async () => Math.abs(await log.evaluate((el) => el.scrollTop) - destination)).toBeLessThanOrEqual(1);
  await expect(markers.nth(1)).toHaveAttribute('aria-current', 'true');
  await latest.click();
  await expect.poll(() => gap(log)).toBeLessThanOrEqual(1);
  t.diagnostic(JSON.stringify({ initial, destination, returnGap: await gap(log) }));
});

test('a smooth Return follows the latest message when a delta extends the thread during the jump', async (t) => {
  const { page, log, latest } = await openThread(t, 'full', true);
  await log.evaluate((el) => new Promise<void>((resolve) => {
    el.addEventListener('scrollend', () => resolve(), { once: true });
    el.scrollTop = 650;
  }));
  await expect(latest).toBeVisible();
  await page.evaluate(() => {
    const host = window as unknown as StreamingHost;
    const { services, world } = host.__kbFake;
    const chat = world.chats.find(({ id }) => id === 'c1')!;
    const request = services.bridge.request.bind(services.bridge);
    services.bridge.request = async (req) => {
      if (req.method === 'GET' && req.path === '/kb/chats/c1/events' && !host.deliverGrowth) {
        await new Promise<void>((resolve) => {
          host.deliverGrowth = () => {
            world.chatEvents.c1 = [{
              seq: ++chat.cursor, type: 'delta', message_id: 'reply-4',
              text: '\n\n' + 'Streamed growth during Return. '.repeat(220),
            }];
            resolve();
          };
        });
      }
      return request(req);
    };
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as StreamingHost).deliverGrowth)).toBe(true);
  await log.evaluate((el) => {
    const host = window as unknown as StreamingHost;
    const initialHeight = el.scrollHeight;
    el.addEventListener('scroll', () => host.deliverGrowth!(), { once: true });
    el.addEventListener('scrollend', () => {
      host.returnLanding = { initialHeight, heightAtEnd: el.scrollHeight, topAtEnd: el.scrollTop };
    }, { capture: true, once: true });
  });
  await latest.press('Enter');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as StreamingHost).returnLanding)).toBe(true);
  const landing = (await page.evaluate(() => (window as unknown as StreamingHost).returnLanding))!;
  t.diagnostic(JSON.stringify({ ...landing, gap: await gap(log) }));
  assert.ok(landing.heightAtEnd > landing.initialHeight + 100, 'the delta grew the thread before native scrollend');
  await expect.poll(() => gap(log)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as Host).__kbFake.services.chats.getState().getReadingAnchor('c1')?.stickToBottom)).toBe(true);
});

test('an inactive expanded row accepts an edge click outside its painted dot', async (t) => {
  const { page, markers } = await openThread(t);
  const marker = markers.nth(1);
  const rail = page.getByRole('navigation', { name: 'Answers in this chat' });
  await rail.hover();
  await expect(rail).toHaveCSS('width', '28px');
  const row = await marker.boundingBox();
  const bounds = await rail.boundingBox();
  assert.ok(row && bounds);
  t.diagnostic(JSON.stringify(row));
  assert.ok(row.width >= 24 && row.height >= 24, 'expanded row has a 24px or larger pointer target');
  const x = bounds.x + 2, y = row.y + row.height / 2;
  assert.ok(await marker.evaluate((el, point) => el.contains(document.elementFromPoint(...point)), [x, y] as [number, number]));
  await page.mouse.click(x, y);
  await expect(marker).toHaveAttribute('aria-current', 'true');
});

for (const accepted of [true, false]) {
  test('only canonical replies receive focusable markers through a delayed ' + (accepted ? 'acknowledgement' : 'refusal'), async (t) => {
    const { page, log, markers } = await openThread(t);
    await page.evaluate(() => {
      const host = window as unknown as Host;
      const { bridge } = host.__kbFake.services;
      const request = bridge.request.bind(bridge);
      bridge.request = async (req) => {
        if (req.method === 'POST' && req.path === '/kb/chats/c1/messages') {
          const accepted = await new Promise<boolean>((resolve) => { host.settleSend = resolve; });
          if (!accepted) return { ok: false, status: 409, detail: 'Synthetic refusal' };
        }
        return request(req);
      };
    });
    const draft = page.getByRole('textbox', { name: 'Message', exact: true });
    await draft.fill('Synthetic question');
    await draft.press('Enter');
    const pending = log.locator('[data-message-id^="local-a"]');
    await expect(pending).toHaveCount(1);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await markers.last().focus();
    const focused = await markers.last().elementHandle();
    assert.ok(focused);
    const pendingCount = await markers.count();
    await page.evaluate((approved) => (window as unknown as Host).settleSend(approved), accepted);
    await expect(pending).toHaveCount(0);
    assert.ok(await focused.evaluate((el) => el === document.activeElement), 'focus survives settlement on the original button');
    assert.equal(pendingCount, 5, 'only canonical targets accept focus');
    await expect(markers).toHaveCount(accepted ? 6 : 5);
    if (accepted) {
      await page.keyboard.press('Tab');
      await expect(markers.last()).toBeFocused();
      await markers.last().press('Enter');
      await expect(markers.last()).toHaveAttribute('aria-current', 'true');
    } else {
      await expect(draft).toHaveText('Synthetic question');
      await expect(page.getByText('Synthetic refusal')).toBeVisible();
    }
  });
}

test('two exact hits in the same reply retain the viewport until Escape restores history', async (t) => {
  const { page, log, latest } = await openThread(t);
  const start = await log.evaluate((el) => { el.scrollTop -= 420; return el.scrollTop; });
  await expect(latest).toBeVisible();
  await log.focus();
  await page.keyboard.press('Control+f');
  const field = page.getByRole('search', { name: 'Find in this chat' }).getByRole('textbox');
  await field.fill('Needle');
  const positions: number[] = [];
  for (let i = 0; i < 2; i++) {
    if (i) await field.press('Enter');
    await expect.poll(() => log.evaluate((el) => {
      const active = CSS.highlights.get('kb-chat-find-active');
      const range = active?.values().next().value;
      if (!(range instanceof Range)) return false;
      const hit = range.getBoundingClientRect(), viewport = el.getBoundingClientRect();
      return hit.top >= viewport.top && hit.bottom <= viewport.bottom;
    })).toBe(true);
    await expect(latest).toHaveCount(0);
    positions.push(await log.evaluate((el) => el.scrollTop));
  }
  assert.ok(positions[0]! < positions[1]! && positions[1]! < start);
  await field.press('Escape');
  await expect(log).toBeFocused();
  assert.equal(await log.evaluate((el) => el.scrollTop), start);
  await latest.click();
  await expect.poll(() => gap(log)).toBeLessThanOrEqual(1);
  t.diagnostic(JSON.stringify({ positions, restored: start }));
});
