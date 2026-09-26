import { expect, test, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Notes screen in the built Electron shell (docs/NOTES-POLISH-SPEC.md): list, tabs,
// live-preview editor, real typing + Cmd+B, autosave read back from the backend,
// light/dark screenshots. UI only — no ASR, no model calls. Isolated profile.
const root = path.resolve(__dirname, '..');
const shots = path.join(root, '.runtime', 'shots', 'notes-editor');

test('notes list, tabs and live-preview editor', async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(shots, { recursive: true });
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-notes-editor-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: userData, PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1400, height: 820 });
  await expect.poll(() => page.evaluate(async () => (await window.audiohelper.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
  await page.evaluate(async () => {
    await window.audiohelper.request({ method: 'PUT', path: '/settings', body: { used_languages: ['ru'] } });
    const s = await window.audiohelper.request<{ id: string }>({ method: 'POST', path: '/sessions', body: { title: 'Лекция по экономике', mode: 'legacy' } });
    const id = (s.data as { id: string }).id;
    const n = await window.audiohelper.request<{ id: string; revision: number }>({ method: 'POST', path: `/sessions/${id}/notes/empty` });
    const note = n.data as { id: string; revision: number };
    const content = '# Спрос и предложение\n\n## Основные понятия\n\n- **Спрос** — количество товара, которое покупатели готовы купить по данной цене.\n- **Предложение** — количество, которое продавцы готовы продать.\n- Равновесие достигается там, где кривые пересекаются.\n\n## Эластичность\n\nЭластичность показывает, насколько сильно спрос реагирует на изменение цены. Для товаров первой необходимости она низкая.\n\n1. Ценовая эластичность\n2. Перекрёстная эластичность\n3. Эластичность по доходу\n';
    await window.audiohelper.request({ method: 'PATCH', path: `/sessions/${id}/notes/${note.id}`, body: { content, expected_revision: note.revision } });
    await window.audiohelper.request({ method: 'POST', path: `/sessions/${id}/notes/empty` });
  });
  await page.reload();
  await expect(page.locator('.gate')).toHaveCount(0, { timeout: 30_000 });
  await page.getByText('Лекция по экономике').first().click();
  await page.getByRole('tab', { name: /Notes/ }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, '01-list.png') });
  await page.getByRole('button', { name: /Open Спрос/ }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '02-open.png') });
  // Live preview: click on the "Эластичность" paragraph shows only that line's marks.
  await page.getByText('Спрос', { exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '03-editing.png') });
  // Real typing + Cmd+B on a real selection, then an autosave round-trip.
  await page.keyboard.press('End');
  await page.keyboard.type(' — рыночный');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(2_600);
  const stored = await page.evaluate(async () => {
    const sessions = await window.audiohelper.request({ method: 'GET', path: '/sessions' }) as { data: { sessions: Array<{ id: string }> } };
    const id = sessions.data.sessions[0]!.id;
    const notes = await window.audiohelper.request({ method: 'GET', path: `/sessions/${id}/notes` }) as { data: { notes: Array<{ content: string }> } };
    return notes.data.notes.map((n) => n.content).join('\n---\n');
  });
  expect(stored).toContain('**рыночный**');
  await page.screenshot({ path: path.join(shots, '03b-typed.png') });
  await page.getByRole('button', { name: 'New notes' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '04-plus-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Close/ }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '05-list-after-close.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.getByRole('button', { name: /Open Спрос/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, '06-open-dark.png') });
  await app.close();
});
