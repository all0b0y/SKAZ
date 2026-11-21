import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import type { Theme } from './shadows';

export async function rendererServer() {
  const root = path.resolve(__dirname, '../../frontend');
  const server = await createServer({ configFile: false, root, plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'src') } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === 'string') throw new Error('No renderer port');
  return { url: 'http://127.0.0.1:' + addr.port, close: () => server.close() };
}

export async function openRenderer(page: Page, base: string, width: number, theme: Theme) {
  await page.setViewportSize({ width, height: 920 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(base + '/src/kb/test/harness.html?hold=1');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.motion = 'full';
  }, theme);
  await page.evaluate(() => document.fonts.ready);
}

// The renderer uses its real settings controls. Only SKAZ's preload/backend boundary is simulated.
export async function tools(page: Page) {
  await page.evaluate(() => {
    const { bridge } = (window as any).__kbFake.services;
    const original = bridge.request.bind(bridge);
    const records: any[] = [];
    (window as any).__seedConnection = () => records.push({ id: 'local-notes', kind: 'mcp', name: 'Local notes',
      active: true, recipient: 'http://127.0.0.1:4198/mcp', trust: 'local', tools: [] });
    const human = { id: 'humanizer', kind: 'skill', name: 'Humanizer', active: true, built_in: true };
    bridge.request = async (req: any) => {
      if (!req.path.startsWith('/kb/settings/tools')) return original(req);
      const ok = (data: unknown) => ({ ok: true, status: 200, data });
      if (req.method === 'GET') return ok({ mcp: records, skills: [human] });
      if (req.method === 'PATCH') {
        const record = records.find(r => req.path.endsWith('/' + r.id));
        Object.assign(record, req.body);
        return ok(record);
      }
      return { ok: false, status: 409, detail: 'A new check is required' };
    };
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Tools', exact: true })).toBeVisible({ timeout: 2500 });
  await settings.getByRole('button', { name: 'Tools', exact: true }).click();
  return settings;
}
