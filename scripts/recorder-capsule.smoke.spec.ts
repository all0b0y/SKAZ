import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Visual fixture: real RecorderBar markup (dumped by RecorderBar.capsuleDump.test.tsx)
// laid out by the built renderer CSS in Electron. No microphone, provider or
// personal data. Asserts geometry that jsdom cannot, then screenshots each state.
const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime/recorder-capsule');

test('recorder capsule states lay out in one centred row', async () => {
  test.setTimeout(120_000);
  const dump = JSON.parse(await fs.readFile(path.join(shots, 'capsule-states.json'), 'utf8')) as Record<string, string>;
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-capsule-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(page.locator('.recorder')).toBeVisible({ timeout: 60_000 });
    for (const [theme, width] of [['light', 760], ['dark', 760], ['light', 560], ['light', 400], ['light', 300]] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const [name, html] of Object.entries(dump)) {
        await page.evaluate(([markup, w]) => {
          // A standalone host outside React's tree, as wide as the centre column.
          let host = document.getElementById('capsule-fixture');
          if (!host) {
            host = document.createElement('div');
            host.id = 'capsule-fixture';
            document.body.append(host);
          }
          host.style.cssText = `position:fixed;left:0;bottom:0;width:${w}px;z-index:9999;`;
          host.innerHTML = markup as string;
        }, [html, width] as const);
        const capsule = page.locator('#capsule-fixture .capsule');
        const expectedState = ['error', 'imported', 'system-on', 'system-denied'].includes(name) ? 'idle'
          : name === 'system-recording' ? 'recording' : name;
        await expect(capsule).toHaveAttribute('data-state', expectedState);
        await page.waitForTimeout(500);
        const geometry = await page.evaluate(() => {
          const scope = document.getElementById('capsule-fixture')!;
          const bar = scope.querySelector('.recorder')!.getBoundingClientRect();
          const c = scope.querySelector('.capsule')!.getBoundingClientRect();
          const kids = [...scope.querySelectorAll('.capsule > :not(.visually-hidden):not(.capsule__progress)')]
            .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
          return { centre: Math.abs((c.left + c.right) / 2 - (bar.left + bar.right) / 2), inside: c.left >= bar.left && c.right <= bar.right,
            oneRow: kids.every((r) => r.top >= c.top - 1 && r.bottom <= c.bottom + 1), height: c.height };
        });
        // Screenshot before asserting, so a failing layout can be looked at.
        await page.locator('#capsule-fixture .recorder').screenshot({ path: path.join(shots, `${theme}-${width}-${name}.png`) });
        const label = `${theme}/${width}/${name}`;
        expect(geometry, label).toMatchObject({ inside: true, oneRow: true });
        expect(geometry.centre, `${label} centred`).toBeLessThan(2);
        expect(geometry.height, `${label} height`).toBeLessThan(64);
      }
    }
  } finally { await app.close(); }
});
