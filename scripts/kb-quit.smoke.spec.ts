import { execFileSync } from 'node:child_process';
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

// The user's rule: a fast relaunch must find the previous SKAZ fully gone, so the new backend can open the
// database and queue. A Dock click / second launch during the unseen shutdown reaches the OLD process; it must
// relaunch only after its backend has exited — and a launch right after the exit must bring a backend up.
test('a fast relaunch during the shutdown waits for the old backend, then a new backend starts', async () => {
  test.setTimeout(180_000);
  const first = await launchIsolatedSmoke('skaz-relaunch-', { keepProfile: true });
  const { profile } = first;
  try {
    const page = await first.app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
    const backendPid = Number(execFileSync('pgrep', ['-P', String(first.app.process().pid), '-f', 'skaz --port'], { encoding: 'utf8' }).trim().split('\n')[0]);
    expect(backendPid, 'the backend process was not found').toBeGreaterThan(0);
    const marks = path.join(fs.realpathSync(os.tmpdir()), `skaz-relaunch-marks-${process.pid}-${Date.now()}.json`);
    const exited = new Promise<void>((resolve) => first.app.process().once('exit', () => resolve()));
    await first.app.evaluate(({ BrowserWindow, app: main }, { pid, file }) => {
      const nodeFs = (process as unknown as { getBuiltinModule: (m: string) => typeof import('fs') }).getBuiltinModule('fs');
      const out: Record<string, number | boolean> = {};
      const save = () => nodeFs.writeFileSync(file, JSON.stringify(out));
      // The real app.relaunch would start an app this test can't control; record when it is asked for instead.
      main.relaunch = () => {
        out.relaunches = ((out.relaunches as number | undefined) ?? 0) + 1;
        try { process.kill(pid, 0); out.backendAliveAtRelaunch = true; } catch { out.backendAliveAtRelaunch = false; }
        save();
      };
      save();
      BrowserWindow.getAllWindows()[0].close();
      // The user clicks SKAZ in the Dock (macOS 'activate') and launches it again (second instance) at once.
      main.emit('activate');
      main.emit('second-instance', {}, [], '');
    }, { pid: backendPid, file: marks });
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('SKAZ did not exit within 15 s')), 15_000))]);
    const out = JSON.parse(fs.readFileSync(marks, 'utf8')) as { relaunches?: number; backendAliveAtRelaunch?: boolean };
    fs.rmSync(marks, { force: true });
    expect(out.relaunches, 'the launch during the shutdown was lost').toBe(1);
    expect(out.backendAliveAtRelaunch, 'relaunch was asked for while the old backend still ran').toBe(false);
    // Launch again right away on the same profile: the new backend must come up.
    const second = await launchIsolatedSmoke('skaz-relaunch-', { profile, keepProfile: true });
    try {
      const page2 = await second.app.firstWindow();
      await expect.poll(() => page2.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
    } finally {
      await second.close();
    }
  } finally {
    await first.close().catch(() => undefined);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  }
});
