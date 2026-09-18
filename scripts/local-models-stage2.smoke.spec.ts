import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Real Electron -> preload -> IPC -> backend smoke. It only reads catalog/status
// and writes settings inside a throwaway profile. It never records, downloads,
// loads a model, or touches the user's shared Hugging Face cache.

const root = path.resolve(__dirname, '..');
const testMain = path.join(root, 'scripts', 'local-models-stage2-smoke', 'main.cjs');
const electronExecutable = createRequire(__filename)('electron') as string;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let modelCacheDir: string;
let partialModelRepo: string;
let siblingModelFile: string;

test('isolated wrapper refuses before production import when sessionData cannot be isolated', async () => {
  const refusedProfile = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-local-models-refuse-')),
  );
  await fs.writeFile(path.join(refusedProfile, 'session'), 'not a directory');
  const child = spawn(electronExecutable, [testMain], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AUDIOHELPER_LOCAL_MODELS_SMOKE_USER_DATA: refusedProfile,
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
    await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-local-models-smoke-')),
  );
  modelCacheDir = path.join(userDataDir, 'model-cache');
  await fs.mkdir(modelCacheDir);
  partialModelRepo = path.join(modelCacheDir, 'models--Systran--faster-whisper-small');
  siblingModelFile = path.join(modelCacheDir, 'models--someone--other-model', 'blobs', 'keep');
  await fs.mkdir(path.join(partialModelRepo, 'blobs'), { recursive: true });
  await fs.writeFile(path.join(partialModelRepo, 'blobs', 'model.bin.incomplete'), 'dummy partial');
  await fs.mkdir(path.dirname(siblingModelFile), { recursive: true });
  await fs.writeFile(siblingModelFile, 'keep sibling');
  app = await electron.launch({
    args: [testMain],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AUDIOHELPER_LOCAL_MODELS_SMOKE_USER_DATA: userDataDir,
      AUDIOHELPER_MODEL_CACHE: modelCacheDir,
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0',
      AUDIOHELPER_LIVE_FINALITY: '0',
      AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });

  const resolved = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    sessionData: electronApp.getPath('sessionData'),
  }));
  expect(await fs.realpath(resolved.userData)).toBe(userDataDir);
  expect(resolved.sessionData.startsWith(resolved.userData)).toBe(true);

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The pill is a bare dot now: its phase lives in the accessible name, not in
  // text content. Assert what the UI actually exposes to a screen reader.
  await expect(page.locator('.status-pill'))
    .toHaveAttribute('aria-label', /backend ready/i, { timeout: 60_000 });
  expect((await fs.stat(path.join(userDataDir, 'data', 'audiohelper.sqlite3'))).isFile()).toBe(true);

  const cacheStatus = await page.evaluate(() => window.audiohelper.request({
    method: 'GET',
    path: '/models/local/status',
    query: { provider: 'local-whisper', model: 'small' },
  }));
  expect(cacheStatus.ok).toBe(true);
  if (!cacheStatus.ok) throw new Error(cacheStatus.detail);
  expect(cacheStatus.data).toMatchObject({
    provider: 'local-whisper',
    model: 'small',
    cached: true,
    shared_cache: false,
  });
  expect(await fs.readFile(path.join(partialModelRepo, 'blobs', 'model.bin.incomplete'), 'utf8'))
    .toBe('dummy partial');
  expect(await fs.readFile(siblingModelFile, 'utf8')).toBe('keep sibling');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true });
});

test('exact GigaChat catalog reaches the UI and real host blocker prevents preparation', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const asr = dialog.locator('section.profile').filter({ hasText: 'Transcription (ASR)' });

  await asr.getByLabel('Provider').selectOption('local-gigachat-mlx');
  const exactModel = 'ai-babai/gigachat-audio-mlx';
  const modelSelect = asr.getByLabel('Model', { exact: true });
  const exactOption = modelSelect.locator(`option[value="${exactModel}"]`);
  await expect(exactOption).toHaveCount(1);
  await expect(exactOption).toHaveText(/GigaChat Audio MLX \(BF16\)/);
  await modelSelect.selectOption(exactModel);
  await expect(modelSelect).toHaveValue(exactModel);

  await expect(asr).toContainText(/pinned 22\.54 GB BF16 artifact/i);
  await expect(asr).toContainText(/16\.0 GiB/i);
  await expect(asr).toContainText(/will not download it or silently switch to q8/i);
  await expect(asr).toContainText(/contextual finality requires local-whisper/i);
  await expect(asr.getByLabel('API key')).toHaveCount(0);
  await expect(asr.getByRole('button', { name: /download/i })).toHaveCount(0);

  await dialog.getByRole('button', { name: /save changes/i }).click();
  await expect(dialog.locator('.drawer__foot .profile__note--ok')).toContainText(/saved/i);
  await dialog.locator('.drawer__close').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: 'Settings' });
  const reopenedAsr = reopened.locator('section.profile').filter({ hasText: 'Transcription (ASR)' });
  await expect(reopenedAsr.getByLabel('Provider')).toHaveValue('local-gigachat-mlx');
  await expect(reopenedAsr.getByLabel('Model', { exact: true })).toHaveValue(exactModel);
  await reopened.locator('.drawer__close').click();

  expect(await fs.readFile(siblingModelFile, 'utf8')).toBe('keep sibling');
});

test('decline preserves and confirm removes only the selected partial cache', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const asr = dialog.locator('section.profile').filter({ hasText: 'Transcription (ASR)' });
  await asr.getByLabel('Provider').selectOption('local-whisper');
  await asr.getByLabel('Model', { exact: true }).selectOption('small');

  const remove = asr.getByRole('button', { name: /delete .*model/i });
  await expect(remove).toBeVisible();

  let declinedMessage = '';
  page.once('dialog', async (confirmation) => {
    declinedMessage = confirmation.message();
    await confirmation.dismiss();
  });
  await remove.click();
  expect(declinedMessage).toContain('small');
  expect(await fs.readFile(path.join(partialModelRepo, 'blobs', 'model.bin.incomplete'), 'utf8'))
    .toBe('dummy partial');

  page.once('dialog', async (confirmation) => confirmation.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);

  const after = await page.evaluate(() => window.audiohelper.request({
    method: 'GET',
    path: '/models/local/status',
    query: { provider: 'local-whisper', model: 'small' },
  }));
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.detail);
  expect(after.data).toMatchObject({
    provider: 'local-whisper',
    model: 'small',
    cached: false,
    shared_cache: false,
  });
  await expect(fs.access(partialModelRepo)).rejects.toThrow();
  expect(await fs.readFile(siblingModelFile, 'utf8')).toBe('keep sibling');
});
