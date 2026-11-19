import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';
import type { KbChat, KbMaterialSummary } from '../frontend/src/api/kb/types.gen';
import type {} from '../frontend/src/api/bridge';

test('V2 imports a disk-backed chat drop and a clipboard image through the native bridge', async () => {
  test.setTimeout(90_000);
  const { app, close, profile } = await launchIsolatedSmoke('skaz-v2-attachments-');
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase),
      { timeout: 60_000 }).toBe('ready');
    const dialog = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await dialog.getByRole('button', { name: 'Skip' }).click();
    await dialog.getByRole('button', { name: 'Create library' }).click();
    await dialog.getByRole('button', { name: 'Open SKAZ' }).click();
    await expect(dialog).toHaveCount(0);

    const created = await page.evaluate(() => window.skaz.request({
      method: 'POST', path: '/kb/chats', body: { title: 'V2 attachment fixture' },
    }));
    expect(created.ok).toBe(true);
    const chat = (created as { data: KbChat }).data;
    await page.getByRole('button', { name: 'V2 attachment fixture', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'V2 attachment fixture' })).toHaveAttribute('aria-selected', 'true');
    const log = page.getByRole('log', { name: 'Conversation' });
    const draft = page.getByRole('list', { name: 'Draft attachments' });
    const editor = page.getByRole('textbox', { name: 'Message' });
    await expect(editor).toBeVisible();

    const fixtures = path.join(__dirname, '..', 'electron', 'nativeIntake041', 'fixtures');
    const docx = path.join(profile, 'Documents', 'sample-note.docx');
    copyFileSync(path.join(fixtures, 'sample-note.docx'), docx);
    const hash = () => createHash('sha256').update(readFileSync(docx)).digest('hex');
    const before = hash();
    const box = await log.boundingBox();
    expect(box).not.toBeNull();
    const x = Math.round(box!.x + box!.width / 2);
    const y = Math.round(box!.y + box!.height / 3);
    // CDP creates a genuine Chromium disk-backed File. The production chat does the drop handling.
    const drag = { x, y, data: { items: [], files: [docx], dragOperationsMask: 1 } };
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
      await expect(page.getByText('Drop files to attach')).toBeVisible();
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
    } finally {
      await cdp.detach();
    }
    await expect(draft.getByRole('button', { name: 'View sample-note.docx' })).toBeVisible();
    await expect(draft.locator('[data-state="ready"]')).toHaveCount(1);
    expect(hash()).toBe(before);

    // Use fixture bytes with a ClipboardEvent so this does not touch the system clipboard.
    // The renderer, preload, main validation/import and local backend are all production code.
    await editor.click();
    await editor.evaluate((target, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Mixed paste text');
      clipboardData.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, Array.from(readFileSync(path.join(fixtures, 'sample-chart.png'))));
    await expect(editor).toHaveText('Mixed paste text');
    await expect(draft.locator('[data-state="ready"]')).toHaveCount(2);
    await expect.poll(() => draft.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const saved = await page.evaluate(async (id) => ({
      materials: await window.skaz.request({ method: 'GET', path: '/kb/materials' }),
      chat: await window.skaz.request({ method: 'GET', path: `/kb/chats/${id}` }),
    }), chat.id);
    expect(saved.materials.ok).toBe(true);
    expect((saved.materials as { data: KbMaterialSummary[] }).data.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['docx', 'image']));
    expect(saved.chat.ok).toBe(true);
    expect((saved.chat as { data: KbChat }).data.messages).toEqual([]);
  } finally {
    await close();
  }
});
