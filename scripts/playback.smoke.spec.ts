import { expect, test, _electron as electron } from '@playwright/test';
import { build as viteBuild } from 'vite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

test('plays persisted synthetic PCM through authenticated backend, preload, Blob, and real decoder', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-playback-smoke-'));
  const rendererDir = path.join(temp, 'renderer');
  const sanitize = (value: string) => value
    .replaceAll(root, '<root>')
    .replaceAll(temp, '<temp>');
  const diagnostics = {
    console: [] as string[],
    pageErrors: [] as string[],
    requestFailures: [] as string[],
    fixtureRequests: [] as string[],
  };
  try {
    await viteBuild({
      root: path.join(root, 'scripts', 'playback-smoke'),
      base: './',
      logLevel: 'error',
      build: { outDir: rendererDir, emptyOutDir: true },
    });
    const app = await electron.launch({
      args: [path.join(root, 'scripts', 'playback-smoke', 'main.cjs')],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        AUDIOHELPER_PLAYBACK_SMOKE_DATA_DIR: temp,
        AUDIOHELPER_PLAYBACK_SMOKE_RENDERER_DIR: rendererDir,
      },
    });
    try {
      const instrumentedPages = new WeakSet<object>();
      const collectPageDiagnostics = (page: Awaited<ReturnType<typeof app.firstWindow>>) => {
        if (instrumentedPages.has(page)) return;
        instrumentedPages.add(page);
        page.on('console', (message) => diagnostics.console.push(sanitize(message.text())));
        page.on('pageerror', (error) => diagnostics.pageErrors.push(sanitize(error.message)));
        page.on('requestfailed', (request) => diagnostics.requestFailures.push(sanitize(
          `${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`,
        )));
        page.on('request', (request) => {
          const url = request.url();
          if (url.startsWith('file:')) diagnostics.fixtureRequests.push(sanitize(url));
        });
      };
      app.on('window', collectPageDiagnostics);
      const page = await app.firstWindow();
      collectPageDiagnostics(page);
      const resultNode = page.locator('#result');
      try {
        await expect(resultNode).not.toHaveText('running', { timeout: 30_000 });
      } catch (error) {
        throw new Error(`playback fixture did not finish: ${sanitize(String(error))}\n${JSON.stringify(diagnostics, null, 2)}`);
      }
      const result = JSON.parse((await resultNode.textContent()) ?? '{}') as Record<string, unknown>;
      try {
        expect(result).toMatchObject({
          passed: true,
          manifestSequences: [10, 20, 30],
          sourceKinds: ['original_captured_wav', 'original_captured_wav', 'original_captured_wav'],
          exactFetches: [20],
          contextSelections: [10, 20, 30],
          exactEnded: true,
          ended: true,
          muted: true,
          bridgeKeys: ['fetchAudio', 'getManifest'],
        });
        expect(result.rendererAsset).toMatch(/^assets\/.*\.js$/);
        expect(result.maxObservedTime).toEqual(expect.any(Number));
        expect(result.maxObservedTime as number).toBeGreaterThan(0.02);
        expect(result.exactCurrentTime).toEqual(expect.any(Number));
        expect(result.exactCurrentTime as number).toBeGreaterThan(0.02);
        expect(result.exactDuration).toEqual(expect.any(Number));
        expect(result.exactDuration as number).toBeGreaterThan(0.3);
        expect(result.exactDuration as number).toBeLessThan(0.5);
        expect(Math.abs((result.exactDuration as number) - (result.exactCurrentTime as number))).toBeLessThan(0.05);
        expect(result.finalCurrentTime).toEqual(expect.any(Number));
        expect(result.finalCurrentTime as number).toBeGreaterThan(0.02);
        expect(result.finalDuration).toEqual(expect.any(Number));
        expect(result.finalDuration as number).toBeGreaterThan(0.3);
        expect(result.finalDuration as number).toBeLessThan(0.5);
        expect(Math.abs((result.finalDuration as number) - (result.finalCurrentTime as number))).toBeLessThan(0.05);
      } catch (error) {
        throw new Error(`playback assertions failed: ${sanitize(String(error))}\n${JSON.stringify(diagnostics, null, 2)}`);
      }
      console.log('[playback-smoke] fixture requests', diagnostics.fixtureRequests);
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
