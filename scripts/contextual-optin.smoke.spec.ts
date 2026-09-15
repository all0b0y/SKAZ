import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Desktop smoke for the experimental contextual local opt-in. It runs the real
// shell against a real backend in a throwaway Electron user-data directory, so
// the user's own settings, sessions and downloaded models are never touched.
// It never presses Record: no microphone, no model download, no paid API call.
// A green run proves the UI opt-in reaches the backend and flips the real
// capability — it says nothing about transcription quality.

const root = path.resolve(__dirname, '..');
const testMain = path.join(root, 'scripts', 'optin-smoke', 'main.cjs');
const electronExecutable = createRequire(__filename)('electron') as string;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test('isolated wrapper refuses before production import when sessionData cannot be isolated', async () => {
  const refusedProfile = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-optin-refuse-')),
  );
  await fs.writeFile(path.join(refusedProfile, 'session'), 'not a directory');
  const child = spawn(electronExecutable, [testMain], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: refusedProfile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, 'exit');

  try {
    expect(exitCode).toBe(97);
    expect(stderr).toContain('refusing to launch');
    await expect(fs.access(path.join(refusedProfile, 'data', 'audiohelper.sqlite3'))).rejects.toThrow();
  } finally {
    await fs.rm(refusedProfile, { recursive: true, force: true });
  }
});

test.beforeAll(async () => {
  userDataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-optin-smoke-')),
  );
  app = await electron.launch({
    // A dedicated test main: it relocates userData through app.setPath before
    // the production main is imported. --user-data-dir placed after an entry
    // point is NOT honoured by Electron, so it must not be relied on here.
    args: [testMain],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: userDataDir,
      // The point of the check is the UI opt-in, so the process-level developer
      // overrides must stay off even if the operator's shell exports them.
      AUDIOHELPER_LIVE_FINALITY: '0',
      AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0',
    },
  });

  // Isolation is asserted before the first window is touched: every later step
  // mutates settings and sessions, and must never reach the real profile.
  const resolved = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    sessionData: electronApp.getPath('sessionData'),
  }));
  expect(await fs.realpath(resolved.userData)).toBe(userDataDir);
  expect(await fs.realpath(resolved.sessionData)).toBe(
    await fs.realpath(path.join(userDataDir, 'session')),
  );

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.status-pill')).toContainText(/backend ready/i, { timeout: 60_000 });

  // The backend inherits the same isolated directory: its database must exist
  // under the temporary profile, never in the user's data directory.
  const db = await fs.stat(path.join(userDataDir, 'data', 'audiohelper.sqlite3'));
  expect(db.isFile()).toBe(true);
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true });
});

const modeSelect = () => page.getByRole('combobox', { name: /transcription mode for new recording/i });
const recordButton = () => page.getByRole('button', { name: /^record$/i });
const optInToggle = () => page.getByRole('checkbox', { name: /experimental contextual local mode/i });

async function openSettings(): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
}

async function closeSettings(): Promise<void> {
  await page.locator('.drawer__close').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
}

async function save(): Promise<void> {
  await page.getByRole('button', { name: /save changes/i }).click();
  // Scoped to the drawer footer: the model-preparation section uses the same class.
  await expect(page.locator('.drawer__foot .profile__note--ok')).toContainText(/saved/i);
}

test('contextual local recording is blocked until the user opts in, then really becomes capable', async () => {
  await modeSelect().selectOption('contextual_local');

  // Off by default: the real backend reports no capability and names the fix.
  await expect(recordButton()).toBeDisabled();
  await expect(page.locator('.recorder__mode-note')).toContainText(/settings/i);

  await openSettings();
  await expect(optInToggle()).not.toBeChecked();
  await optInToggle().check();
  await save();
  await closeSettings();

  // The capability re-read after saving comes from the backend, not from local state.
  await expect(recordButton()).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('.recorder__mode-note')).toContainText(
    /contextual local recording is available/i,
  );
});

test('persists the opt-in and creates a real contextual session without touching the microphone', async () => {
  await openSettings();
  await expect(optInToggle()).toBeChecked();
  await closeSettings();

  await expect(modeSelect()).toHaveValue('contextual_local');
  await page.getByRole('button', { name: /new session/i }).click();

  // Contextual-only affordance: it renders solely for a session the backend
  // stored with mode=contextual_local.
  await expect(page.getByRole('button', { name: /resume contextual processing/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.recorder__badge--live')).toHaveCount(0);
});

test('restores a real persisted recovery status through Electron IPC without capture or ASR', async () => {
  const sessions = await page.evaluate(() => window.audiohelper.request<{ sessions: Array<{ id: string; mode: string }> }>({
    method: 'GET',
    path: '/sessions',
  }));
  expect(sessions.ok).toBe(true);
  if (!sessions.ok) throw new Error(sessions.detail);
  const sessionId = sessions.data.sessions.find((item) => item.mode === 'contextual_local')?.id;
  expect(sessionId).toBeTruthy();
  if (!sessionId) throw new Error('contextual session was not persisted');

  const stored = await page.evaluate(async (id) => {
    const sampleRate = 16_000;
    const sampleCount = 1_600;
    const wav = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(wav);
    const writeText = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeText(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, sampleCount * 2, true);
    return window.audiohelper.storeAudio(
      id,
      { sequence: 0, startMs: 0, endMs: 100 },
      wav,
    );
  }, sessionId);
  expect(stored.ok).toBe(true);

  const stopped = await page.evaluate((id) => window.audiohelper.request({
    method: 'PATCH',
    path: `/sessions/${id}`,
    body: { status: 'stopped', flush_transcription: false },
  }), sessionId);
  expect(stopped.ok).toBe(true);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.status-pill')).toContainText(/backend ready/i, { timeout: 60_000 });
  const progress = page.getByLabel('Contextual transcription progress');
  await expect(progress).toContainText(/processing stalled: finality_blocked/i, { timeout: 15_000 });

  const scheduler = await page.evaluate((id) => window.audiohelper.request({
    method: 'GET',
    path: `/sessions/${id}/asr/live/scheduler`,
  }), sessionId);
  expect(scheduler.ok).toBe(true);
  if (!scheduler.ok) throw new Error(scheduler.detail);
  expect(scheduler.data).toMatchObject({
    captured_target_sequence: 0,
    status: 'stalled',
    block_reason: 'finality_blocked',
    source_ended: true,
    recovery_required: true,
    available_audio_processed: false,
  });
});

test('turning the opt-in back off disables contextual recording again', async () => {
  // Reload restores the renderer-only next-recording choice to the safe legacy
  // default. Legacy recording must remain available regardless of contextual opt-in.
  await expect(modeSelect()).toHaveValue('legacy');
  await openSettings();
  await expect(optInToggle()).toBeChecked();
  await optInToggle().uncheck();
  await save();
  await closeSettings();

  const capability = await page.evaluate(() => window.audiohelper.request({
    method: 'GET',
    path: '/asr/live/capabilities',
  }));
  expect(capability.ok).toBe(true);
  if (!capability.ok) throw new Error(capability.detail);
  expect(capability.data).toMatchObject({
    mode: 'contextual_local',
    capable: false,
    requirements: {
      contextual_local_enabled: false,
      live_finality_enabled: false,
      local_speech_gate_enabled: false,
    },
  });

  await modeSelect().selectOption('contextual_local');
  await expect(recordButton()).toBeDisabled({ timeout: 15_000 });
  await expect(page.locator('.recorder__mode-note')).toContainText(/settings/i);
});
