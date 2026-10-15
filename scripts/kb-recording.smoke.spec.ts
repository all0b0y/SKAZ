import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchIsolatedSmoke } from './isolatedSmoke';

// Recording in the Knowledge Wiki interface on the REAL built Electron app, real preload/IPC policy
// and real local backend, in an isolated profile (ported from the old save-on-quit,
// transcript-only and recording-retry smokes, audit AUDIT-L1 violation 3).
//
// Fixtures, and nothing else:
//  - browser audio acquisition: getUserMedia / AudioContext / AudioWorkletNode are replaced in the
//    page by an injected PCM source that the spec drives frame by frame (no microphone);
//  - the Soniox connector (scripts/fake-soniox): no network; in `words` mode it answers every audio
//    frame with the fixed word "fixture". This is NOT speech recognition — it only lets the
//    lifecycle (live text → quit → restart → continue, provider error → retry) run end to end.
// The stored Soniox key is a placeholder; no provider request is ever made.

const root = path.resolve(__dirname, '..');
const shots = process.env.SKAZ_F2_SHOTS ?? path.join(root, '.runtime', 'shots', 'kb-recording');
const FIXTURE_DIR = path.join(root, 'scripts', 'fake-soniox');
/** One 100 ms window at 16 kHz, the size the recorder chunks into. */
const FRAME = 1600;

interface Running { app: ElectronApplication; page: Page; close: () => Promise<void>; profile: string }

async function launch(prefix: string, env: Record<string, string>, profile?: string): Promise<Running> {
  const { app, close, profile: dir } = await launchIsolatedSmoke(prefix, {
    profile, keepProfile: true, env: { PYTHONPATH: FIXTURE_DIR, ...env },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(async () => (await window.skaz.getBackendStatus()).phase), { timeout: 60_000 }).toBe('ready');
  return { app, page, close, profile: dir };
}

async function bridge<T>(page: Page, method: string, reqPath: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T; detail?: string }> {
  return page.evaluate(({ m, p, b }) => window.skaz.request({ method: m as 'GET', path: p, ...(b === undefined ? {} : { body: b }) }),
    { m: method, p: reqPath, b: body }) as never;
}

/** First launch done through the real routes: the library in the isolated Documents, a placeholder Soniox key, consent. */
async function prepare(run: Running, { key = true }: { key?: boolean } = {}) {
  const { page, profile } = run;
  // The window may only set recording options on the legacy route (electron/ipcPolicy.ts); consent,
  // provider and key go through the routes the Settings dialogs use.
  const settings = await bridge(page, 'PUT', '/settings', { native_recording_mode: 'transcription' });
  expect(settings.ok, settings.detail).toBe(true);
  const speech = await bridge(page, 'PUT', '/kb/settings/speech', { provider: 'soniox', languages: ['ru', 'en'], cloud_consent: true });
  expect(speech.ok, speech.detail).toBe(true);
  if (key) {
    const stored = await bridge(page, 'PUT', '/kb/settings/keys/soniox', { key: 'smoke-fixture-key' });
    expect(stored.ok, stored.detail).toBe(true);
  }
  const library = await bridge(page, 'POST', '/kb/library', { path: path.join(profile, 'Documents', 'SKAZ') });
  expect(library.ok, library.detail).toBe(true);
  await page.evaluate(() => localStorage.setItem('skaz.kb.prefs', JSON.stringify({ onboardingDone: true, theme: 'system' })));
  await page.reload();
  await expect(recordButton(page)).not.toHaveAttribute('aria-disabled', /./, { timeout: 30_000 });
}

/** A changed screen at 1440 in light and dark (system theme, emulated). */
async function shoot(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const titlebar = (page: Page) => page.getByTestId('titlebar');
const recordButton = (page: Page) => titlebar(page).getByRole('button', { name: 'Record', exact: true });
const capsule = (page: Page) => titlebar(page).getByRole('button', { name: /^(Recording|Paused) \d/ });
const livePanel = (page: Page) => page.getByRole('complementary', { name: 'Live recording' });

/** Stop through the capsule's control row (opened by hovering, as a pointer user does). */
async function stopRecording(page: Page) {
  await capsule(page).hover();
  const row = page.getByRole('dialog', { name: 'Recording controls' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(recordButton(page)).toBeVisible({ timeout: 20_000 });
}

/**
 * The injected PCM source. `emit()` delivers one 100 ms frame; with `holdFlush` the worklet answers
 * the recorder's flush barrier only when the spec calls `release()` (audio still in flight), and
 * with `neverFlush` it never answers (the capture graph is stuck).
 */
async function injectCapture(page: Page, mode: 'normal' | 'holdFlush' | 'neverFlush' = 'normal') {
  await page.evaluate(({ mode: m, frame }) => {
    const fixture = { barrier: 0, emit: (_voiced: boolean) => {}, release: () => {}, attempts: 0 };
    Object.assign(window, { captureFixture: fixture });
    const track = { stop() {}, addEventListener() {} };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => { fixture.attempts += 1; return { getTracks: () => [track], getAudioTracks: () => [track] }; },
    } });
    class FixtureContext {
      sampleRate = 16000;
      state = 'running';
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async close() { this.state = 'closed'; }
    }
    class FixtureWorklet {
      port = {
        onmessage: null as null | ((event: { data: Float32Array | { type: string; id: number } }) => void),
        postMessage: (message: { type: string; id: number }) => {
          fixture.barrier = message.id;
          if (m === 'normal') { this.port.onmessage?.({ data: message }); return; }
          // 16 samples still inside the graph when the flush was asked for: the in-flight audio.
          this.port.onmessage?.({ data: new Float32Array(16).fill(-0.5) });
          if (m === 'holdFlush') fixture.release = () => this.port.onmessage?.({ data: message });
        },
        close() {},
      };
      disconnect() {}
      constructor() { fixture.emit = (voiced) => this.port.onmessage?.({ data: new Float32Array(frame).fill(voiced ? 0.5 : 0) }); }
    }
    Object.assign(window, { AudioContext: FixtureContext, AudioWorkletNode: FixtureWorklet });
  }, { mode, frame: FRAME });
}

/** Frames through the injected source: voiced ones get the fixture word, silent ones none. */
const emit = (page: Page, frames: boolean[] = [true]) => page.evaluate((list) => {
  for (const voiced of list) (window as unknown as { captureFixture: { emit: (v: boolean) => void } }).captureFixture.emit(voiced);
}, frames);
/** Speech, a pause longer than a monologue gap (2.5 s), speech: the first monologue closes and shows live. */
const PHRASES = [true, ...Array<boolean>(27).fill(false), true];

async function material(page: Page, id: string) {
  return bridge<{ status: string; fragments: Array<{ text: string; start_ms: number | null }> }>(page, 'GET', `/kb/materials/${id}`);
}

async function live(page: Page, sessionId: string) {
  return bridge<{ saved_samples: number; next_sequence: number; audio_retained: boolean; transcription: string }>(page, 'GET', `/sessions/${sessionId}/live`);
}

/** Every file under a directory (the strongest form of "no audio was archived"). */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

async function recordingIds(page: Page) {
  return page.evaluate(async () => {
    const res = await window.skaz.request<Array<{ id: string; kind: string }>>({ method: 'GET', path: '/kb/materials' });
    if (!res.ok) throw new Error(res.detail);
    return res.data.filter((m) => m.kind === 'recording').map((m) => m.id);
  });
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => { fs.mkdirSync(shots, { recursive: true }); });

for (const outcome of ['acknowledged', 'quit-timeout'] as const) {
  test(`quit during a recording (${outcome}): in-flight audio is saved, the material keeps its text after restart, recording continues`, async () => {
    test.setTimeout(180_000);
    let run: Running | null = await launch('skaz-kb-quit-', { SKAZ_SMOKE_FAKE_SONIOX: 'words' });
    const profile = run.profile;
    try {
      const { app, page } = run;
      await prepare(run);
      await injectCapture(page, outcome === 'acknowledged' ? 'holdFlush' : 'neverFlush');
      await recordButton(page).click();
      await expect(capsule(page)).toBeVisible();
      await emit(page, PHRASES);
      // The recognised (fixture) text reaches the live panel through the real stream and projection.
      await expect(livePanel(page)).toContainText('fixture', { timeout: 20_000 });
      const [materialId] = await recordingIds(page);
      expect(materialId).toBeTruthy();

      // Replace only the native dialog decision, keeping the production quit orchestration.
      await app.evaluate(({ dialog }) => {
        const decisions = { calls: 0, discard: false };
        Object.assign(globalThis, { quitDecisions: decisions });
        dialog.showMessageBoxSync = () => { decisions.calls += 1; return decisions.discard ? 1 : 0; };
      });
      const closed = app.waitForEvent('close');
      await app.evaluate(({ app: main }) => { setImmediate(() => main.quit()); });
      await page.waitForFunction(() => (window as unknown as { captureFixture: { barrier: number } }).captureFixture.barrier > 0);
      // A second quit and a window close while the flush is pending must not cut it short.
      await app.evaluate(({ app: main, BrowserWindow }) => { main.quit(); BrowserWindow.getAllWindows()[0]?.close(); });
      expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(() => window.skaz.getBackendStatus())).toMatchObject({ phase: 'ready' });
      if (outcome === 'acknowledged') {
        await page.evaluate(() => (window as unknown as { captureFixture: { release: () => void } }).captureFixture.release());
      } else {
        // The flush never confirms (2 s barrier timeout): SKAZ asks before quitting instead of exiting silently.
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { quitDecisions: { calls: number } }).quitDecisions.calls), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
        expect(page.isClosed()).toBe(false);
        // "Stay" kept SKAZ running with the backend up; the recording itself was stopped and settled.
        await expect(recordButton(page)).toBeVisible();
        await expect(page.getByRole('alert').filter({ hasText: /last moment of audio/ })).toBeVisible();
        await shoot(page, 'quit-unconfirmed-flush');
        expect(await page.evaluate(() => window.skaz.getBackendStatus())).toMatchObject({ phase: 'ready' });
        await app.evaluate(({ app: main }) => {
          (globalThis as unknown as { quitDecisions: { discard: boolean } }).quitDecisions.discard = true;
          setImmediate(() => main.quit());
        });
      }
      await closed;
      run = null;

      // Restart on the same profile: the material and its text are there, the clock includes the in-flight PCM.
      run = await launch('skaz-kb-quit-', { SKAZ_SMOKE_FAKE_SONIOX: 'words' }, profile);
      const again = run.page;
      await again.evaluate(() => localStorage.setItem('skaz.kb.prefs', JSON.stringify({ onboardingDone: true, theme: 'system' })));
      await again.reload();
      await expect(recordButton(again)).not.toHaveAttribute('aria-disabled', /./, { timeout: 30_000 });
      const after = await material(again, materialId!);
      expect(after.ok).toBe(true);
      expect(after.data.status).toBe('ready');
      expect(after.data.fragments.map((f) => f.text).join(' ')).toContain('fixture');
      const view = await bridge<{ session_id: string; recording_state: string }>(again, 'GET', `/kb/recordings/${materialId}`);
      expect(view.data.recording_state).toBe('stopped');
      const first = await live(again, view.data.session_id);
      // Every frame + the 16 samples that were still in the graph when quit asked for the flush: they
      // are saved in both outcomes. With an unconfirmed flush SKAZ cannot know whether more was still
      // inside the audio graph — which is exactly why it asked before quitting.
      const sent = PHRASES.length * FRAME;
      expect(first.data).toMatchObject({ saved_samples: sent + 16, audio_retained: false });

      // Continue the same recording through the material view (the old "Continue recording").
      await again.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Materials/ }).click();
      await again.getByRole('region', { name: 'Materials' }).getByRole('button', { name: /^Recording/ }).first().click();
      const doc = again.getByRole('complementary', { name: 'Document' });
      await expect(doc.getByText('fixture', { exact: false }).first()).toBeVisible();
      await injectCapture(again, 'normal');
      if (outcome === 'acknowledged') await shoot(again, 'continue-after-restart');
      await doc.getByRole('button', { name: 'Continue recording' }).click();
      await expect(capsule(again)).toBeVisible();
      await emit(again);
      await expect.poll(async () => (await live(again, view.data.session_id)).data.saved_samples, { timeout: 15_000 })
        .toBe(first.data.saved_samples + FRAME);
      await stopRecording(again);
      const continued = await material(again, materialId!);
      expect(continued.data.status).toBe('ready');
      // Text from before the quit is kept; text of the continued part follows it, later in time.
      const times = continued.data.fragments.map((f) => f.start_ms ?? 0);
      expect(times.length).toBeGreaterThanOrEqual(after.data.fragments.length);
      expect(continued.data.fragments.slice(0, after.data.fragments.length).map((f) => f.text)).toEqual(after.data.fragments.map((f) => f.text));
      expect((await recordingIds(again))).toEqual([materialId]);

      // Transcript-only (the old transcript-only smoke): the PCM advanced the clock and was never archived.
      expect((await live(again, view.data.session_id)).data).toMatchObject({ audio_retained: false, saved_samples: first.data.saved_samples + FRAME });
      expect(await again.evaluate(() => 'fetchAudio' in window.skaz)).toBe(false);
      const audio = [...filesUnder(path.join(profile, 'data')), ...filesUnder(path.join(profile, 'Documents'))]
        .filter((f) => /\.(wav|pcm|webm|ogg|m4a|mp3|flac)$/i.test(f));
      expect(audio).toEqual([]);
    } finally {
      if (run) {
        await run.app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
        await run.close();
      }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}

test('continuous speech with no pause: the live panel shows the words before any monologue closes', async () => {
  test.setTimeout(120_000);
  const run = await launch('skaz-kb-live-', { SKAZ_SMOKE_FAKE_SONIOX: 'words' });
  try {
    const { page } = run;
    await prepare(run);
    await injectCapture(page, 'normal');
    await recordButton(page).click();
    await expect(capsule(page)).toBeVisible();
    const [materialId] = await recordingIds(page);
    // One speaker, voiced frames only: 2 s of speech without a single silent frame, so no
    // monologue can close (pause > 2.5 s, another speaker, or 2 minutes) — the old panel showed nothing here.
    for (let i = 0; i < 20; i += 1) await emit(page, [true]);
    const panel = livePanel(page);
    await expect(panel.locator('.kb-live-final')).toContainText('fixture', { timeout: 10_000 });
    const text = await material(page, materialId!);
    expect(text.data.fragments).toEqual([]);  // nothing closed: the words came through the live route
    await expect(panel.getByText(/Listening/)).toHaveCount(0);
    await shoot(page, 'live-continuous');
    // More continuous speech: the same open monologue grows in place, it doesn't restart.
    const before = (await panel.locator('.kb-live-final').innerText()).split('fixture').length;
    for (let i = 0; i < 10; i += 1) await emit(page, [true]);
    await expect.poll(async () => (await panel.locator('.kb-live-final').innerText()).split('fixture').length, { timeout: 10_000 })
      .toBeGreaterThan(before);
    await stopRecording(page);
    // Stop closes it into the material: the same words, shown once.
    const done = await material(page, materialId!);
    expect(done.data.fragments).toHaveLength(1);
    await expect(panel.locator('.kb-live-final')).toHaveCount(0, { timeout: 10_000 });
    await expect(panel).toContainText('fixture');
  } finally {
    await run.close();
    fs.rmSync(run.profile, { recursive: true, force: true });
  }
});

test('provider error: Record says why without a key; recognition stops on its own; Continue recording retries and recovers', async () => {
  test.setTimeout(180_000);
  const control = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skaz-fake-soniox-')), 'mode');
  fs.writeFileSync(control, 'refuse');
  const run = await launch('skaz-kb-retry-', { SKAZ_SMOKE_FAKE_SONIOX: 'control', SKAZ_SMOKE_FAKE_SONIOX_CONTROL: control });
  try {
    const { page } = run;
    await prepare(run, { key: false });
    await injectCapture(page, 'normal');
    // Not connected: Record says why and nothing records (the stream refuses before any audio is sent).
    await recordButton(page).click();
    const refusal = page.getByRole('dialog', { name: 'Recording didn’t start' });
    await expect(refusal).toContainText(/Soniox/);
    await expect(recordButton(page)).toBeVisible();
    await refusal.getByRole('button', { name: 'OK' }).click();
    const before = new Set(await recordingIds(page));
    expect((await bridge(page, 'PUT', '/kb/settings/keys/soniox', { key: 'smoke-fixture-key' })).ok).toBe(true);

    // Connected but the provider is unreachable: SKAZ retries the same provider, then stops honestly.
    await recordButton(page).click();
    await expect(capsule(page)).toBeVisible();
    await emit(page);
    const panel = livePanel(page);
    // While SKAZ retries the same provider (attempts 2 and 3), the recording UI says so instead of nothing.
    await expect(panel.getByRole('status').filter({ hasText: 'Reconnecting to Soniox…' })).toBeVisible({ timeout: 15_000 });
    await expect(capsule(page)).toContainText('Reconnecting…');
    await expect(panel.getByRole('note')).toContainText('Recording continues');
    await shoot(page, 'reconnecting');
    const stopped = panel.getByRole('alert');
    await expect(stopped).toContainText('Recognition stopped at', { timeout: 30_000 });
    await expect(stopped).toContainText(/Soniox/);
    await expect(stopped).toContainText('Recording won’t continue by itself.');
    await expect(recordButton(page)).toBeVisible();
    await shoot(page, 'retry-stopped');
    const [materialId, ...extra] = (await recordingIds(page)).filter((id) => !before.has(id));
    expect(extra).toEqual([]);

    // The provider is back: Continue recording reconnects into the same material and recognises.
    fs.writeFileSync(control, 'words');
    await stopped.getByRole('button', { name: 'Continue recording' }).click();
    await expect(capsule(page)).toBeVisible();
    await emit(page, PHRASES);
    await expect(panel).toContainText('fixture', { timeout: 20_000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await stopRecording(page);
    const done = await material(page, materialId!);
    expect(done.data.status).toBe('ready');
    expect(done.data.fragments.map((f) => f.text).join(' ')).toContain('fixture');
    // Continue recorded into the same material: no new one appeared.
    expect((await recordingIds(page)).filter((id) => !before.has(id))).toEqual([materialId]);
  } finally {
    await run.close();
    fs.rmSync(run.profile, { recursive: true, force: true });
    fs.rmSync(path.dirname(control), { recursive: true, force: true });
  }
});
