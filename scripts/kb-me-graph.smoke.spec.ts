import { expect, test } from '@playwright/test';
import { launchIsolatedSmoke } from './isolatedSmoke';
import type {} from '../frontend/src/api/bridge';

const instruction = 'When introducing a term, give one example.';

test('Settings Me uses the default graph over the Electron bridge', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { app, close } = await launchIsolatedSmoke('skaz-me-graph-');
  try {
    const page = await app.firstWindow();
    const welcome = page.getByRole('dialog', { name: 'Welcome to SKAZ' });
    await welcome.getByRole('button', { name: 'Next' }).click();
    await welcome.getByRole('button', { name: 'Skip' }).click();
    await welcome.getByRole('button', { name: 'Skip' }).click();
    await welcome.getByRole('button', { name: 'Create library' }).click();
    await welcome.getByRole('button', { name: 'Open SKAZ' }).click();
    await expect(welcome).toHaveCount(0);

    const seeded = await page.evaluate(() => window.skaz.request<{ id: string }>({
      method: 'POST', path: '/kb/chats', body: { title: 'Synthetic retention check' },
    }));
    if (!seeded.ok) throw new Error('Could not create the isolated chat fixture');
    await page.reload();
    await page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /Synthetic retention check/ }).first().click();
    const openedChat = page.getByRole('region', { name: 'Chat', exact: true });
    const more = openedChat.getByRole('button', { name: /^More for/ });
    await more.click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete this chat?' });
    const keep = deletion.getByRole('checkbox', { name: /learning counts in Me/ });
    await expect(keep).toBeChecked();
    await keep.uncheck();
    await deletion.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    await expect.poll(() => page.evaluate(async (id) => (
      await window.skaz.request({ method: 'GET', path: `/kb/chats/${id}` })
    ).status, seeded.data.id)).toBe(404);

    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Me', exact: true }).click();
    await expect(settings.getByRole('heading', { name: 'What you told me' })).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Patterns' })).toBeVisible();

    await settings.getByRole('button', { name: 'Access & learning' }).click();
    const study = settings.getByRole('switch', { name: 'Learn from Study' });
    const chat = settings.getByRole('switch', { name: 'Learn from Chat' });
    await expect(study).toBeChecked();
    await expect(chat).toBeChecked();
    await study.click();
    await expect(study).not.toBeChecked();
    await expect(chat).toBeChecked();

    await settings.getByRole('button', { name: 'Add entry' }).click();
    await settings.getByRole('textbox', { name: 'Instruction or fact' }).fill(instruction);
    await settings.getByRole('combobox', { name: 'Applies in' }).selectOption('chat');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText(instruction, { exact: true })).toBeVisible();
    const why = settings.getByRole('button', { name: 'Why this?', exact: true });
    await why.focus();
    await page.keyboard.press('Enter');
    await expect(settings.getByText('You added this entry in Me.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(why).toBeFocused();

    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 760, deviceScaleFactor: 1, mobile: false,
      });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(390);
      await expect(settings.getByRole('combobox', { name: 'Settings section' })).toHaveValue('me');
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await expect(settings.getByText(instruction, { exact: true })).toBeVisible();
        await why.click();
        await expect(settings.getByText('You added this entry in Me.')).toBeVisible();
        const fits = await settings.locator('.kb-settings__content').evaluate(
          (el) => el.scrollWidth <= el.clientWidth + 1,
        );
        expect(fits, theme).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`me-${theme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
      }
    } finally {
      await cdp.detach();
    }

    const opposite = 'When introducing a term, skip examples.';
    await settings.getByRole('button', { name: 'Add entry' }).click();
    await settings.getByRole('textbox', { name: 'Instruction or fact' }).fill(opposite);
    await settings.getByRole('combobox', { name: 'Applies in' }).selectOption('chat');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText(/Conflicting instructions/)).toHaveCount(2);
    await settings.getByRole('button', { name: 'Why this?', exact: true }).first().click();
    await expect(settings.getByText(/This conflicts with/)).toContainText(opposite);
    await page.keyboard.press('Escape');

    await settings.getByRole('button', { name: 'Erase…', exact: true }).click();
    await settings.getByRole('button', { name: 'Erase all Me data' }).click();
    await expect(study).not.toBeChecked();
    await expect(chat).not.toBeChecked();
    await expect(settings.getByText(instruction, { exact: true })).toHaveCount(0);
  } finally {
    await close();
  }
});
