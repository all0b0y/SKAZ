import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIsolatedSmoke } from './isolatedSmoke';

// The user's rule: SKAZ leaves the screen within 200 ms of a close (window close or Cmd+Q) when no audio is
// at risk; saving and stopping the backend then finish unseen, and the process still exits on its own.
const BUDGET_MS = 200;

for (const how of ['window close', 'Cmd+Q (app.quit)'] as const) {
  test(`the window is gone within ${BUDGET_MS} ms — ${how}`, async () => {
    test.setTimeout(120_000);
    const { app, close } = await launchIsolatedSmoke('skaz-quit-');
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('titlebar')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1_500); // the backend is up and idle
      const marks = path.join(fs.realpathSync(os.tmpdir()), `skaz-quit-marks-${process.pid}-${Date.now()}.json`);
      const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
      await app.evaluate(({ BrowserWindow, app: main }, { mode, file }) => {
        const nodeFs = (process as unknown as { getBuiltinModule: (m: string) => typeof import('fs') }).getBuiltinModule('fs');
        const win = BrowserWindow.getAllWindows()[0];
        const out: Record<string, number> = {};
        const start = performance.now();
        const mark = (k: string) => { out[k] ??= Math.round(performance.now() - start); nodeFs.writeFileSync(file, JSON.stringify(out)); };
        win.once('hide', () => mark('hidden'));
        main.once('will-quit', () => mark('willQuit'));
        if (mode === 'window close') win.close(); else main.quit();
        if (!win.isVisible()) mark('hidden');
      }, { mode: how, file: marks });
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('SKAZ did not exit within 15 s')), 15_000))]);
      const out = JSON.parse(fs.readFileSync(marks, 'utf8')) as { hidden?: number; willQuit?: number };
      fs.rmSync(marks, { force: true });
      console.log(`[kb-quit] ${how}: hidden after ${out.hidden} ms, quit after ${out.willQuit} ms`);
      expect(out.hidden, 'the window never left the screen').toBeDefined();
      expect(out.hidden!).toBeLessThanOrEqual(BUDGET_MS);
      expect(out.willQuit, 'the app never reached will-quit').toBeDefined();
    } finally {
      await close().catch(() => undefined);
    }
  });
}
