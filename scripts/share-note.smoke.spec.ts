import { expect, test } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// CODEX-NOTES-FIX-SPEC §5-6 through the real preload bridge and Electron main:
// the renderer hands over a name and text, main writes one private `.md` file and
// opens the macOS share sheet. The renderer-side menu is covered by vitest; this
// checks what actually lands on disk. Isolated profile; no backend data involved.

const root = path.resolve(__dirname, '..');

test('share note writes one clean private .md and refuses unsafe names', async () => {
  test.skip(process.platform !== 'darwin', 'The share sheet exists only on macOS');
  // The real macOS share sheet is a native modal that Escape from the page does
  // not dismiss, so an unattended run hangs to the worker timeout. Run it with
  // someone at the machine: SKAZ_SMOKE_SHARE_SHEET=1 npx playwright test share-note
  test.skip(!process.env.SKAZ_SMOKE_SHARE_SHEET, 'Needs a person to dismiss the native share sheet');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-share-smoke-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      TMPDIR: directory,
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      AUDIOHELPER_SESSION_FILES_ROOT: path.join(directory, 'session-files'),
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const temp = await app.evaluate(({ app: electronApp }) => electronApp.getPath('temp'));

    const content = '# Устойчивость\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    expect(await page.evaluate((text) => window.audiohelper.shareNote!({
      fileName: 'Устойчивость', content: text, x: 40, y: 40,
    }), content)).toBe(true);
    await page.keyboard.press('Escape'); // dismiss the real share sheet

    const shareRoot = (await fs.readdir(temp)).filter((name) => name.startsWith('skaz-share-'));
    expect(shareRoot).toHaveLength(1);
    const base = path.join(temp, shareRoot[0]!);
    const [one] = await fs.readdir(base);
    const files = await fs.readdir(path.join(base, one!));
    expect(files).toEqual(['Устойчивость.md']);
    const file = path.join(base, one!, files[0]!);
    expect(await fs.readFile(file, 'utf8')).toBe(content);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    // A traversal name stays a plain file inside its own directory; '..' is refused.
    expect(await page.evaluate(() => window.audiohelper.shareNote!({
      fileName: '../../escape', content: 'x', x: 0, y: 0,
    }))).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.audiohelper.shareNote!({
      fileName: '..', content: 'x', x: 0, y: 0,
    }))).toBe(false);
    const all = await fs.readdir(base, { recursive: true });
    expect(all.filter((entry) => entry.endsWith('.md')).map((entry) => path.basename(entry)).sort())
      .toEqual(['escape.md', 'Устойчивость.md'].sort());
    await expect(fs.access(path.join(temp, 'escape.md'))).rejects.toThrow();
  } finally {
    await app.close();
  }
  // Scratch is removed when the app quits.
  const left = (await fs.readdir(directory)).filter((name) => name.startsWith('skaz-share-'));
  expect(left).toEqual([]);
  await fs.rm(directory, { recursive: true, force: true });
});
