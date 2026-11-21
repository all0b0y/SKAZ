import { expect, test } from '@playwright/test';
import { dialogShadow, compare } from './tools-files041/shadows';
import { openRenderer, rendererServer, tools } from './tools-files041/renderer';

let server: Awaited<ReturnType<typeof rendererServer>>;
test.beforeAll(async () => { server = await rendererServer(); });
test.afterAll(async () => { await server?.close(); });

for (const kind of ['MCP', 'skill']) {
  test('Submit Add ' + kind + ' sends the source in the open chat', async ({ page }, info) => {
    const theme = kind === 'MCP' ? 'dark' : 'light';
    await openRenderer(page, server.url, 1440, theme);
    await page.evaluate(() => (window as any).__kbFake.services.chats.getState().open('c1'));
    const settings = await tools(page);
    if (kind === 'skill') await settings.getByRole('tab', { name: /^Skills/ }).click();
    await settings.getByRole('button', { name: 'Add ' + kind, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add ' + kind, exact: true });
    const url = 'https://community.test/' + (kind === 'MCP' ? 'mcp' : 'SKILL.md');
    await dialog.getByRole('textbox').fill(url);
    await page.screenshot({ path: info.outputPath('form.png') });
    const sample = await dialogShadow(page, dialog);
    expect(await compare(page, 'tools-dialog-neutral-' + theme + '-1440', sample.delta, info.outputPath('shadow-diff.png'))).toBeLessThanOrEqual(4);
    await dialog.getByRole('button', { name: 'Send to chat' }).click({ timeout: 3000 });
    await expect(settings).toBeHidden();
    await expect(page.getByRole('article', { name: 'Your question' }).last().getByRole('link')).toHaveAttribute('href', url);
    const sent = await page.evaluate(() => (window as any).__kbFake.services.chats.getState().chats.c1.chat.messages
      .filter((m: any) => m.role === 'user').map((m: any) => m.input.text));
    expect(sent.filter((t: string) => t.includes(url))).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('sent.png') });
  });
}

test('A failed chat send keeps the filled form for a single retry', async ({ page }) => {
  await openRenderer(page, server.url, 820, 'dark');
  await page.evaluate(async () => {
    const { services } = (window as any).__kbFake;
    await services.chats.getState().open('c1');
    const bridge = services.bridge, original = bridge.request.bind(bridge);
    let attempts = 0;
    bridge.request = async (request: any) => {
      if (request.method === 'POST' && request.path === '/kb/chats/c1/messages' && ++attempts === 1) {
        return { ok: false, status: 409, detail: 'Chat is busy.' };
      }
      return original(request);
    };
  });
  const settings = await tools(page);
  await settings.getByRole('button', { name: 'Add MCP' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add MCP' });
  const url = 'https://community.test/mcp';
  await dialog.getByRole('textbox').fill(url);
  await dialog.getByRole('button', { name: 'Send to chat' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue(url);
  await dialog.getByRole('button', { name: 'Send to chat' }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('article', { name: 'Your question' }).last().getByRole('link')).toHaveAttribute('href', url);
});
