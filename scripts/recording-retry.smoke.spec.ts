import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

// Real UI/preload/main/backend. Fixtures: browser audio acquisition, and the
// Soniox connector (scripts/fake-soniox), which refuses every connection the
// way an unreachable provider would. The stored key is a placeholder; no
// physical microphone, provider request or personal profile is involved.
test('Record waits for a Soniox key and consent, then warns on every failed attempt without blocking another session', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skaz-record-retry-')));
  const app = await electron.launch({
    args: [path.join(root, 'scripts/optin-smoke/main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      AUDIOHELPER_SESSION_FILES_ROOT: path.join(directory, 'files'),
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
      PYTHONPATH: path.join(root, 'scripts', 'fake-soniox'), AUDIOHELPER_SMOKE_FAKE_SONIOX: 'refuse',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    const onboarding = page.getByRole('dialog', { name: 'Which languages do you speak?' });
    await expect(onboarding).toBeVisible();
    await onboarding.getByRole('button', { name: 'Russian + English', exact: true }).click();
    await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(onboarding).not.toBeVisible();
    await page.evaluate(() => {
      let attempts = 0;
      const track = { stop() {}, addEventListener() {} };
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        document.documentElement.dataset.captureAttempts = String(++attempts);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      } });
      // With a key and consent the stream opens as "connecting" and capture
      // really starts; the refused provider connection then ends it.
      class FixtureContext {
        sampleRate = 16000;
        state = 'running';
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        async close() { this.state = 'closed'; }
      }
      class FixtureWorklet {
        port = {
          onmessage: null as null | ((event: { data: unknown }) => void),
          postMessage: (message: unknown) => { this.port.onmessage?.({ data: message }); },
          close() {},
        };
        disconnect() {}
      }
      Object.defineProperty(window, 'AudioContext', { value: FixtureContext });
      Object.defineProperty(window, 'AudioWorkletNode', { value: FixtureWorklet });
    });
    const record = page.getByRole('button', { name: 'Record', exact: true });
    const openSettings = page.getByRole('button', { name: 'Open settings', exact: true });

    // Not connected: Record is refused up front, with the reason and the way in.
    await expect(record).toBeDisabled();
    await expect(page.getByText(/Transcription is not set up — add a Soniox API key/)).toBeVisible();
    await openSettings.click();
    await expect(page.getByRole('button', { name: 'API keys', exact: true })).toHaveAttribute('aria-current', 'true');
    await page.getByLabel('Soniox API key').fill('smoke-fixture-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    // A key alone is not enough: cloud processing is still off.
    await expect(record).toBeDisabled();
    await expect(page.getByText(/cloud processing is off/)).toBeVisible();
    await openSettings.click();
    await page.getByRole('checkbox', { name: /Allow cloud processing/ }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(openSettings).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-capture-attempts', /./);

    // Connected but the provider is unreachable: every attempt warns, none blocks.
    const warning = page.locator('.capsule [role="alert"]');
    for (const attempt of ['1', '2']) {
      await expect(record).toBeEnabled();
      await record.click();
      await expect(warning).toContainText(/Transcription (is unavailable|failed)/);
      await expect(record).toBeEnabled();
      await expect(page.locator('html')).toHaveAttribute('data-capture-attempts', attempt);
      await page.getByRole('button', { name: 'Dismiss error' }).click();
      await expect(warning).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.locator('.session__name')).toHaveCount(2);
    await expect(warning).toHaveCount(0);
    await record.click();
    await expect(warning).toContainText(/Transcription (is unavailable|failed)/);
    await expect(record).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-capture-attempts', '3');
    const sessions = await page.evaluate(() => window.audiohelper.request<{ sessions: Array<{ status: string }> }>({
      method: 'GET', path: '/sessions',
    }));
    expect(sessions.ok && sessions.data.sessions.every((s) => s.status === 'stopped')).toBe(true);
    await page.screenshot({ path: path.join(root, '.runtime/recording-retry.png') });
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
