import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

async function launch(directory: string) {
  const app = await electron.launch({
    args: [path.join(root, 'scripts', 'optin-smoke', 'main.cjs')], cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production',
      AUDIOHELPER_OPTIN_SMOKE_USER_DATA: directory,
      AUDIOHELPER_SESSION_FILES_ROOT: path.join(directory, 'session-files'),
      PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      AUDIOHELPER_ALLOW_MODEL_DOWNLOAD: '0', AUDIOHELPER_LIVE_FINALITY: '0', AUDIOHELPER_LOCAL_SPEECH_GATE: '0',
    },
  });
  const paths = await app.evaluate(({ app }) => ({ user: app.getPath('userData'), session: app.getPath('sessionData') }));
  expect(await fs.realpath(paths.user)).toBe(directory);
  expect(await fs.realpath(paths.session)).toBe(path.join(directory, 'session'));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
  return { app, page };
}

// Browser capture boundary fixture only. Production recorder/store/preload/main/backend are unchanged.
// No physical microphone, real speech, provider credentials, model loading or external API.
for (const outcome of ['acknowledged', 'quit-timeout', 'pause-timeout'] as const) {
test(`capture ${outcome}: quit protects in-flight PCM and keeps the session clock after restart`, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audiohelper-quit-smoke-')));
  let active: ElectronApplication | null = null;
  try {
    const first = await launch(directory);
    active = first.app;
    const { app, page } = first;
    const settings = await page.evaluate(() => window.audiohelper.request({
      method: 'PUT', path: '/settings', body: {
        asr: { provider: 'openai', model: 'whisper-1' }, cloud_consent: false,
        used_languages: ['ru', 'en'],
      },
    }));
    expect(settings.ok).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const fixture = { barrier: 0, stoppedTracks: 0, emit: () => {}, release: () => {} };
      Object.assign(window, { quitFixture: fixture });
      const track = { stop: () => { fixture.stoppedTracks += 1; }, addEventListener: () => {} };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
      } });
      class FixtureContext {
        sampleRate = 16000;
        state = 'running';
        audioWorklet = { addModule: async () => {} };
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
        async close() { this.state = 'closed'; }
      }
      class FixtureWorklet {
        port = {
          onmessage: null as null | ((event: { data: Float32Array | { type: string; id: number } }) => void),
          postMessage: (message: { type: string; id: number }) => {
            fixture.barrier = message.id;
            this.port.onmessage?.({ data: new Float32Array(16).fill(-1) });
            fixture.release = () => this.port.onmessage?.({ data: message });
          },
          close: () => {},
        };
        disconnect() {}
        constructor() { fixture.emit = () => this.port.onmessage?.({ data: new Float32Array(1600).fill(1) }); }
      }
      Object.assign(window, { AudioContext: FixtureContext, AudioWorkletNode: FixtureWorklet });
    });
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    const id = await page.evaluate(async () => {
      (window as unknown as { quitFixture: { emit: () => void } }).quitFixture.emit();
      const response = await window.audiohelper.request<{ sessions: Array<{ id: string }> }>({ method: 'GET', path: '/sessions' });
      if (!response.ok || !response.data.sessions[0]) throw new Error('recording not created');
      return response.data.sessions[0].id;
    });
    // Replace only the native dialog decision, keeping production quit orchestration.
    await app.evaluate(({ dialog }) => {
      const decisions = { calls: 0, discard: false };
      Object.assign(globalThis, { quitDecisions: decisions });
      dialog.showMessageBoxSync = () => { decisions.calls += 1; return decisions.discard ? 1 : 0; };
    });
    if (outcome === 'pause-timeout') {
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(page.getByText(/capture completeness is unknown/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue recording', exact: true })).toBeEnabled();
    }
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await page.waitForFunction(() => (window as unknown as { quitFixture: { barrier: number } }).quitFixture.barrier > 0);
    await app.evaluate(({ app, BrowserWindow }) => { app.quit(); BrowserWindow.getAllWindows()[0]?.close(); });
    expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
    if (outcome === 'acknowledged') {
      await page.evaluate(() => (window as unknown as { quitFixture: { release: () => void } }).quitFixture.release());
    } else {
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { quitDecisions: { calls: number } }).quitDecisions.calls)).toBeGreaterThanOrEqual(1);
      await expect(page.getByText(/capture completeness is unknown/)).toBeVisible();
      expect(page.isClosed()).toBe(false);
      expect(await page.evaluate(() => window.audiohelper.getBackendStatus())).toMatchObject({ phase: 'ready' });
      // A late ACK and another quit must still refuse silent exit.
      await page.evaluate(() => (window as unknown as { quitFixture: { release: () => void } }).quitFixture.release());
      const before = await app.evaluate(() => (globalThis as unknown as { quitDecisions: { calls: number } }).quitDecisions.calls);
      await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { quitDecisions: { calls: number } }).quitDecisions.calls)).toBeGreaterThan(before);
      expect(page.isClosed()).toBe(false);
      await app.evaluate(({ app }) => {
        (globalThis as unknown as { quitDecisions: { discard: boolean } }).quitDecisions.discard = true;
        setImmediate(() => app.quit());
      });
    }
    await closed;
    active = null;

    const transcriptPath = path.join(directory, 'session-files', 'Ungrouped', id, 'Transcript.md');
    expect(await fs.readFile(transcriptPath, 'utf8')).toContain('No stable transcript');

    const second = await launch(directory);
    active = second.app;
    const result = await second.page.evaluate(async (sessionId) => {
      const detail = await window.audiohelper.request({ method: 'GET', path: `/sessions/${sessionId}` });
      // Transcript-only policy: the received PCM advances the session clock but
      // is never archived, so the manifest stays empty and playback refuses.
      const manifest = await window.audiohelper.request<{ chunks: Array<{ sequence: number }> }>({ method: 'GET', path: `/sessions/${sessionId}/audio` });
      if (!manifest.ok) throw new Error('audio manifest unavailable');
      const audio = await window.audiohelper.fetchAudio(sessionId, 0);
      return { detail, sequences: manifest.data.chunks.map((chunk) => chunk.sequence),
        playback: { ok: audio.ok, status: audio.ok ? 200 : audio.status } };
    }, id);
    expect(result.detail).toMatchObject({ ok: true, data: { session: { status: 'stopped', duration_ms: 101 } } });
    expect(result.sequences).toEqual([]);
    expect(result.playback).toEqual({ ok: false, status: 404 });
    expect(await fs.readdir(path.join(directory, 'data', 'audio')).catch(() => [])).toEqual([]);
    if (outcome === 'acknowledged') {
      // Reopen through the actual UI/store/writer, not a direct openNative call.
      await second.page.evaluate(() => {
        const fixture = { emit: () => {} };
        Object.assign(window, { continueFixture: fixture });
        const track = { stop() {}, addEventListener() {} };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
          enumerateDevices: async () => [],
          getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
        } });
        class Context {
          sampleRate = 16000;
          state = 'running';
          audioWorklet = { addModule: async () => {} };
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          async close() { this.state = 'closed'; }
        }
        class Worklet {
          port = {
            onmessage: null as null | ((event: { data: Float32Array | { type: string; id: number } }) => void),
            postMessage: (message: { type: string; id: number }) => { this.port.onmessage?.({ data: message }); },
            close() {},
          };
          disconnect() {}
          constructor() { fixture.emit = () => this.port.onmessage?.({ data: new Float32Array(1600).fill(0.5) }); }
        }
        Object.assign(window, { AudioContext: Context, AudioWorkletNode: Worklet });
      });
      await second.page.getByRole('button', { name: 'Continue recording', exact: true }).click();
      await expect(second.page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      await second.page.evaluate(() => (window as unknown as { continueFixture: { emit: () => void } }).continueFixture.emit());
      await second.page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(second.page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
      const continued = await second.page.evaluate(async (sid) => ({
        sessions: await window.audiohelper.request({ method: 'GET', path: '/sessions' }),
        snapshot: await window.audiohelper.request({ method: 'GET', path: `/sessions/${sid}/live` }),
        original: await window.audiohelper.fetchAudio(sid, 0).then((audio) => ({ ok: audio.ok, status: audio.ok ? 200 : audio.status })),
        appended: await window.audiohelper.fetchAudio(sid, 2).then((audio) => ({ ok: audio.ok, status: audio.ok ? 200 : audio.status })),
      }), id);
      expect(continued.sessions).toMatchObject({ ok: true, data: { sessions: [{ id }] } });
      // The restored sample clock proves the earlier capture was accounted for
      // even though neither the original nor the appended block was archived.
      expect(continued.snapshot).toMatchObject({ ok: true, data: { saved_samples: 3216, next_sequence: 3, audio_retained: false } });
      expect(continued.original).toEqual({ ok: false, status: 404 });
      expect(continued.appended).toEqual({ ok: false, status: 404 });
    }
  } finally {
    if (active) {
      await active.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
      await active.close();
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
}
