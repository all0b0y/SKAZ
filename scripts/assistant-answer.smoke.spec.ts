import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Visual fixture: real AssistantPanel markup (dumped by AssistantPanel.answerDump.test.tsx)
// laid out by the built renderer CSS in Electron. No provider or personal data.
const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime/assistant-answer');

test('rich answer with inline footnotes lays out inside the assistant column', async () => {
  test.setTimeout(120_000);
  const html = await fs.readFile(path.join(shots, 'answer.html'), 'utf8');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-answer-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      SKAZ_OPTIN_SMOKE_USER_DATA: directory, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      SKAZ_ALLOW_MODEL_DOWNLOAD: '0', SKAZ_LIVE_FINALITY: '0', SKAZ_LOCAL_SPEECH_GATE: '0' },
  });
  try {
    expect(await fs.realpath(await app.evaluate(({ app: a }) => a.getPath('userData')))).toBe(directory);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(([markup, t]) => {
        document.documentElement.setAttribute('data-theme', t!);
        let host = document.getElementById('answer-fixture');
        if (!host) {
          host = document.createElement('div');
          host.id = 'answer-fixture';
          host.style.cssText = 'position:fixed;right:0;top:0;width:380px;height:900px;z-index:9999;display:flex;background:var(--paper);';
          document.body.append(host);
        }
        host.innerHTML = markup!;
      }, [html, theme]);
      await page.waitForTimeout(300);
      const facts = await page.evaluate(() => {
        const scope = document.getElementById('answer-fixture')!;
        const bubble = scope.querySelector('.msg__bubble--rich')!.getBoundingClientRect();
        const refs = [...scope.querySelectorAll('.footnote__ref')].map((el) => el.getBoundingClientRect());
        const table = scope.querySelector('.md table')?.getBoundingClientRect();
        return {
          refs: refs.length,
          refsInside: refs.every((r) => r.left >= bubble.left && r.right <= bubble.right && r.height < 20),
          noRawLabels: !/\[P\d/.test(scope.textContent ?? ''),
          tableInside: table ? table.right <= bubble.right + 1 : false,
          legacyList: scope.querySelectorAll('[aria-label="Answer sources"]').length,
        };
      });
      expect(facts, theme).toEqual({ refs: 5, refsInside: true, noRawLabels: true, tableInside: true, legacyList: 1 });
      await page.locator('#answer-fixture').screenshot({ path: path.join(shots, `${theme}.png`) });
    }
  } finally { await app.close(); }
});
