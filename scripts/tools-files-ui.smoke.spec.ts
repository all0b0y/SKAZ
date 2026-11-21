import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { verifyMotion } from './tools-files041/motion';
import { compare, dialogShadow, shadow, sizes, themes, visibleAndFits } from './tools-files041/shadows';
import { openRenderer, rendererServer, tools } from './tools-files041/renderer';

let server: Awaited<ReturnType<typeof rendererServer>>;
test.beforeAll(async () => { server = await rendererServer(); });
test.afterAll(async () => { await server?.close(); });
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const file = info.outputPath('actual-renderer.png');
    await page.screenshot({ path: file });
    await info.attach('actual-renderer', { path: file, contentType: 'image/png' });
  }
});
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp('^' + name + '(?:\\s|$)') });
const add = (page: Page) => page.getByRole('button', { name: 'Add MCP', exact: true });
const sheet = (page: Page) => page.getByRole('tablist', { name: 'Tool type' }).locator('[aria-hidden="true"]').first();

for (const theme of themes) for (const width of sizes) {
  test('V1 Tools first launch, checks, correction and keyboard ' + theme + ' ' + width, async ({ page }) => {
    await openRenderer(page, server.url, width, theme);
    const settings = await tools(page);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.getByText('No connections yet')).toBeVisible();
    await tab(page, 'MCP').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Skills')).toBeFocused();
    await expect(page.getByRole('switch', { name: 'Humanizer' })).toBeChecked();
    const install = page.getByRole('button', { name: 'Add skill' });
    await install.click();
    await expect(page.getByRole('dialog', { name: 'Add skill' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(install).toBeFocused();
    await tab(page, 'MCP').click();
    await add(page).click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP' });
    const url = dialog.getByRole('textbox');
    await url.fill('invalid');
    await dialog.getByRole('button', { name: 'Send to chat' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await url.fill('http://127.0.0.1:4198/mcp');
    await dialog.getByRole('button', { name: 'Send to chat' }).click();
    await expect(settings).toBeHidden();
    await page.evaluate(() => (window as any).__seedConnection());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await settings.getByRole('button', { name: 'Tools', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Local notes' });
    await expect(toggle).toHaveText(/Active/);
    await toggle.click();
    await tab(page, 'Skills').click();
    await tab(page, 'MCP').click();
    await expect(toggle).toHaveText(/Inactive/);
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await visibleAndFits(settings);
  });

  test('V2 product raster against approved HTML ' + theme + ' ' + width, async ({ page }, info) => {
    await openRenderer(page, server.url, width, theme);
    await tools(page);
    for (const kind of ['pill', 'idle', 'dialog']) {
      if (kind === 'dialog') await add(page).click();
      const target = kind === 'pill' ? sheet(page) : kind === 'idle' ? tab(page, 'Skills') : page.getByRole('dialog', { name: 'Add MCP' });
      if (kind === 'dialog') await page.screenshot({ path: info.outputPath('dialog-in-settings.png') });
      const sample = kind === 'dialog' ? await dialogShadow(page, target) : await shadow(page, target);
      await info.attach(kind + '-actual', { body: sample.raw, contentType: 'image/png' });
      await info.attach(kind + '-shadow', { body: sample.delta, contentType: 'image/png' });
      fs.writeFileSync(info.outputPath(kind + '-raw.png'), sample.raw);
      expect(await compare(page, ['tools', kind === 'dialog' ? 'dialog-neutral' : kind, theme, width].join('-'), sample.delta, info.outputPath(kind + '-diff.png'))).toBeLessThanOrEqual(4);
      if (kind !== 'dialog') {
        expect(await compare(page, ['tools', kind, theme, width, 'raw'].join('-'), sample.raw,
          info.outputPath(kind + '-surface-diff.png'))).toBeLessThanOrEqual(4);
      }
    }
  });
}

test('V3 both directions, mid-flight reversal and Reduce Motion', async ({ page }) => {
  await openRenderer(page, server.url, 1440, 'light'); await tools(page);
  await verifyMotion(page, sheet(page), tab);
});

for (const theme of themes) for (const width of sizes) {
  test('V4 send, expand sources, preview and download answer file ' + theme + ' ' + width, async ({ page }, info) => {
    await openRenderer(page, server.url, width, theme);
    const body = 'Конспект с буквой ё.\n';
    await page.evaluate(async ({ byteCount, encoded }) => {
      const h = (window as any).__kbFake;
      await h.services.chats.getState().open('c1');
      const materials = ['one.txt', 'two.txt', 'three.txt', 'remove.txt'].map((title, i) => ({
        ...h.world.materials[0], id: 'fixture-mat-' + i, title, kind: 'text', status: 'ready' }));
      h.world.materials.push(...materials);
      await h.services.library.getState().loadContent();
      const drafts = h.services.composer.getState().attachmentDrafts.getState();
      await drafts.addFiles('c1', materials.map(m => ({ name: m.title,
        load: async () => ({ id: m.id, ready: true, existing: true }) })), false);
      const original = h.services.bridge.request.bind(h.services.bridge);
      const file = { type: 'file', id: 'fixture-result', name: 'Итог.txt', mime_type: 'text/plain', size: byteCount };
      h.services.bridge.request = async (req: any) => {
        if (/^\/kb\/chats\/c1\/messages\/[^/]+\/files\/fixture-result$/.test(req.path))
          return { ok: true, status: 200, data: { ...file, data: encoded } };
        const res = await original(req);
        if (req.method === 'POST' && req.path === '/kb/chats/c1/messages' && res.ok) {
          const msg = res.data.assistant;
          // The fixture supplies a result from the external application to this answer only.
          h.world.pendingAnswers.c1.unshift({ type: 'part', message_id: msg.id, part: file });
          h.finish('c1');
        }
        return res;
      };
    }, { byteCount: Buffer.byteLength(body), encoded: Buffer.from(body).toString('base64') });
    const draft = page.getByRole('list', { name: 'Draft attachments' });
    const count = await page.getByRole('article', { name: 'Your question' }).count();
    const remove = page.getByRole('button', { name: 'Remove remove.txt', exact: true });
    if (!await remove.isVisible()) await page.getByRole('button', { name: /Show all 4 attachments/i }).click();
    await remove.click();
    if (await page.getByRole('dialog', { name: 'Attachments' }).isVisible()) await page.keyboard.press('Escape');
    await expect(draft).toBeVisible();
    await expect(page.getByRole('article', { name: 'Your question' })).toHaveCount(count);
    const editor = page.getByRole('textbox', { name: 'Message' });
    await editor.fill('Assemble the notes.'); await editor.press('Enter');
    const user = page.getByRole('article', { name: 'Your question' }).filter({ hasText: 'Assemble the notes.' });
    await expect(user).toBeVisible();
    await user.getByRole('button', { name: /Show all 3/i }).click({ timeout: 3000 });
    const list = page.getByRole('dialog', { name: /Attached files|Attachments/i });
    for (const name of ['one.txt', 'two.txt', 'three.txt']) await expect(list.getByText(name, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const answer = page.getByRole('article', { name: 'Answer' }).filter({ hasText: 'Итог.txt' });
    await expect(answer).toContainText(Buffer.byteLength(body) + ' B');
    const outside: string[] = [];
    page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== server.url) outside.push(r.url()); });
    await answer.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Итог.txt' });
    await expect(preview).toContainText(body.trim());
    await page.screenshot({ path: info.outputPath('preview-in-chat.png') });
    const sample = await dialogShadow(page, preview);
    await info.attach('preview-shadow', { body: sample.raw, contentType: 'image/png' });
    expect(await compare(page, ['chat', 'dialog-neutral', theme, width].join('-'), sample.delta, info.outputPath('preview-diff.png'))).toBeLessThanOrEqual(4);
    await page.keyboard.press('Escape');
    const download = page.waitForEvent('download');
    await answer.getByText('Download', { exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('Итог.txt');
    expect(fs.readFileSync((await saved.path())!)).toEqual(Buffer.from(body));
    expect(outside).toEqual([]);
  });
}

test('V4 the original remains downloadable when preview is unavailable', async ({ page }) => {
  await openRenderer(page, server.url, 820, 'dark');
  const bytes = Buffer.from([0, 125, 255, 17]);
  page.on('pageerror', err => console.error('Result file renderer:', err.message));
  await page.evaluate(async encoded => {
    const h = (window as any).__kbFake, chat = h.world.chats.find((c: any) => c.id === 'c1');
    const file = { type: 'file', id: 'opaque', name: 'data.bin', size: 4, mime_type: 'application/octet-stream' };
    const msg = chat.messages.find((m: any) => m.role === 'assistant');
    msg.parts = [{ type: 'text', text: 'Binary result.' }, file];
    const request = h.services.bridge.request.bind(h.services.bridge);
    h.services.bridge.request = (req: any) => req.path === '/kb/chats/c1/messages/' + msg.id + '/files/opaque'
      ? Promise.resolve({ ok: true, status: 200, data: { ...file, data: encoded } }) : request(req);
    await h.services.chats.getState().open(chat.id);
  }, bytes.toString('base64'));
  const answer = page.getByRole('article', { name: 'Answer' }).filter({ hasText: 'Binary result.' });
  await expect(answer).toBeVisible();
  await expect(answer.getByText('data.bin', { exact: true })).toBeVisible();
  const wait = page.waitForEvent('download');
  await answer.getByText('Download', { exact: true }).click();
  const downloaded = await wait;
  expect(downloaded.suggestedFilename()).toBe('data.bin');
  expect(fs.readFileSync((await downloaded.path())!)).toEqual(bytes);
});

test('V1 an unverified publisher is disclosed before a third-party MCP is added', async ({ page }) => {
  await openRenderer(page, server.url, 820, 'light');
  await page.evaluate(async () => {
    const h = (window as any).__kbFake;
    await h.services.chats.getState().open('c1');
    const bridge = h.services.bridge, original = bridge.request.bind(bridge);
    bridge.request = async (req: any) => {
      const res = await original(req);
      const match = /^\/kb\/chats\/([^/]+)\/messages$/.exec(req.path);
      if (req.method === 'POST' && match && res.ok) {
        const id = match[1]!;
        const part = { type: 'permission', id: 'test-connect', kind: 'mcp_connect', title: 'Notes',
          engine: 'codex', recipient: 'https://third.test/mcp', arguments: { trust: 'unverified' },
          changes: [], summary: { added: 0, changed: 0, removed: 0 }, auto: false, status: 'pending' };
        h.world.pendingAnswers[id].unshift({ type: 'part', message_id: res.data.assistant.id, part });
        h.finish(id);
      }
      return res;
    };
  });
  await tools(page); await add(page).click();
  const d = page.getByRole('dialog', { name: 'Add MCP' });
  await d.getByRole('textbox').fill('https://third.test/mcp');
  await d.getByRole('button', { name: 'Send to chat' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Unverified MCP publisher.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow in this chat' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
});

test('Opening an active MCP shows its current tool catalog', async ({ page }) => {
  await openRenderer(page, server.url, 820, 'light');
  const settings = await tools(page);
  await page.evaluate(() => {
    (window as any).__seedConnection();
    const { bridge } = (window as any).__kbFake.services;
    const original = bridge.request.bind(bridge);
    let refreshes = 0;
    bridge.request = async (req: any) => {
      if (req.method === 'POST' && req.path === '/kb/settings/tools/local-notes/refresh') {
        const previous = await original({ path: '/kb/settings/tools', method: 'GET' });
        const item = previous.data.mcp.find((row: any) => row.id === 'local-notes');
        const name = ++refreshes === 1 ? 'new_note' : 'update_note';
        return { ok: true, status: 200, data: {
          ...item, tools: [{ name, description: 'Current tool', inputSchema: { type: 'object' } }],
        } };
      }
      return original(req);
    };
  });
  await settings.getByRole('button', { name: 'Models', exact: true }).click();
  await settings.getByRole('button', { name: 'Tools', exact: true }).click();
  const connection = settings.getByRole('group', { name: 'Local notes' });
  await connection.getByRole('button', { name: '0 tools', exact: true }).click();
  await expect(connection.getByText('new_note', { exact: true })).toBeVisible();
  await expect(connection.getByRole('button', { name: '1 tool', exact: true })).toBeVisible();
  const refresh = connection.getByRole('button', { name: 'Refresh tools', exact: true });
  await refresh.click();
  await expect(connection.getByText('update_note', { exact: true })).toBeVisible();
  await connection.getByRole('switch', { name: 'Local notes' }).click();
  await expect(refresh).toBeDisabled();
  await expect(connection.getByText('update_note', { exact: true })).toBeVisible();
});
