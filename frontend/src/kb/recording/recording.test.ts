import { describe, expect, it, vi } from 'vitest';
import { createUiStore } from '../state/ui';
import { createFakeBridge, docWorld } from '../test/fakeBridge';
import type { CaptureCallbacks, CaptureEngine, CaptureStart } from './capture';
import { barsFrom, SILENT_BARS } from './level';
import { createRecordingStore } from './recordingStore';
import { KbClient } from '../api/client';

/** A capture engine with no sound hardware: it reports what the store asked and lets tests speak. */
function fakeEngine() {
  const calls: string[] = [];
  let callbacks: CaptureCallbacks | null = null;
  let started: CaptureStart | null = null;
  let elapsed = 0;
  let saved = true;
  let incomplete = false;
  const engine: CaptureEngine = {
    start: vi.fn(async (start, cb) => { started = start; callbacks = cb; calls.push('start'); }),
    pause: vi.fn(async () => { calls.push('pause'); }),
    resume: vi.fn(async () => { calls.push('resume'); }),
    stop: vi.fn(async () => { calls.push('stop'); return saved; }),
    elapsedMs: () => elapsed,
    pending: () => ({ pending: saved ? 0 : 3, failed: 0 }),
    incomplete: () => incomplete,
  };
  return {
    engine, calls,
    get started() { return started; },
    level: (dbfs: number) => callbacks!.onLevel({ dbfs, peakDbfs: dbfs + 6, clipping: false }),
    fail: (message: string) => callbacks!.onFailure(message),
    setElapsed: (ms: number) => { elapsed = ms; },
    unsaved: () => { saved = false; },
    flushUnconfirmed: () => { incomplete = true; },
  };
}

function setup() {
  const fake = createFakeBridge(docWorld());
  const ui = createUiStore();
  const eng = fakeEngine();
  const store = createRecordingStore({
    client: new KbClient(fake.bridge), bridge: fake.bridge, ui, capture: () => eng.engine, sleep: async () => undefined,
  });
  const routes = () => fake.calls.map((c) => `${c.method} ${c.path}`);
  return { fake, ui, eng, store, routes };
}

describe('Capsule level bars', () => {
  it('stand still in silence and move only with the real signal', () => {
    expect(barsFrom(null)).toEqual(SILENT_BARS);
    expect(barsFrom({ dbfs: -60, peakDbfs: -60, clipping: false })).toEqual(SILENT_BARS);
    expect(barsFrom({ dbfs: -55, peakDbfs: -53, clipping: false })).toEqual(SILENT_BARS);
    const loud = barsFrom({ dbfs: -12, peakDbfs: -4, clipping: false });
    expect(loud[0]).toBeGreaterThan(0.5);
    expect(loud[1]).toBeGreaterThan(loud[0]);
    expect(barsFrom({ dbfs: -12, peakDbfs: -4, clipping: false })).toEqual(loud);
  });
});

describe('Recording store over /kb/recordings and the existing capture pipeline', () => {
  it('Record: material + session, a new chat about it, the live panel, then capture on that session', async () => {
    const { store, ui, eng, routes, fake } = setup();
    await store.getState().loadOptions();
    expect(store.getState().options).toMatchObject({ folderId: 'phys', mode: 'translation', target: 'ru' });
    await store.getState().start();
    const s = store.getState();
    expect(s.phase).toBe('recording');
    expect(routes()).toEqual(expect.arrayContaining(['POST /kb/recordings', 'POST /kb/chats']));
    expect(fake.calls.find((c) => c.path === '/kb/recordings')?.body).toEqual({ folder_id: 'phys' });
    expect(eng.started?.sessionId).toBe(s.sessionId);
    expect(ui.getState().right).toEqual({ kind: 'live', materialId: s.materialId });
    expect(s.view).toBe('translation');
    await vi.waitFor(() => expect(store.getState().chatId).toMatch(/^c\d+$/));
    expect(fake.bridge.reportCaptureState).toHaveBeenLastCalledWith({ recorderState: 'recording', pending: 0, failed: 0 });
  });

  it('bars follow the signal while recording and drop to still on pause', async () => {
    const { store, eng } = setup();
    await store.getState().start();
    eng.level(-10);
    expect(store.getState().bars[1]).toBeGreaterThan(0);
    await store.getState().pause();
    expect(store.getState().phase).toBe('paused');
    expect(store.getState().bars).toEqual(SILENT_BARS);
    eng.level(-10);
    expect(store.getState().bars).toEqual(SILENT_BARS);
  });

  it('pause ends the stream first, then settles; resume re-checks with the backend; stop finishes', async () => {
    const { store, eng, routes } = setup();
    await store.getState().start();
    const id = store.getState().materialId!;
    await store.getState().pause();
    await store.getState().resume();
    expect(store.getState().phase).toBe('recording');
    await store.getState().stop();
    expect(eng.calls).toEqual(['start', 'pause', 'resume', 'stop']);
    expect(routes().filter((r) => r.includes(id))).toEqual([
      `POST /kb/recordings/${id}/pause`, `POST /kb/recordings/${id}/resume`, `POST /kb/recordings/${id}/stop`,
    ]);
    expect(store.getState().phase).toBe('idle');
  });

  it('recognition stops on its own: the text is kept, nothing continues by itself, "Continue recording" resumes', async () => {
    const { store, eng } = setup();
    await store.getState().start();
    eng.setElapsed(761_000);
    eng.fail('Soniox stopped answering.');
    await vi.waitFor(() => expect(store.getState().failure).not.toBeNull());
    expect(store.getState()).toMatchObject({ phase: 'idle', failure: { atMs: 761_000, message: 'Soniox stopped answering.' } });
    expect(eng.calls).toEqual(['start', 'stop']);
    await store.getState().continueAfterFailure();
    expect(store.getState().phase).toBe('recording');
    expect(store.getState().failure).toBeNull();
    expect(eng.started?.sampleRate).toBe(48000);
  });

  it('a stopped recording continues into the same material, session and sample clock (after a restart too)', async () => {
    const { store, eng, routes, ui, fake } = setup();
    await store.getState().start();
    const { materialId, sessionId } = store.getState();
    await store.getState().stop();
    // A fresh store stands for the app after a restart: nothing in memory about that recording.
    const after = createRecordingStore({
      client: new KbClient(fake.bridge), bridge: fake.bridge, ui, capture: () => eng.engine, sleep: async () => undefined,
    });
    await after.getState().continueRecording(materialId!);
    expect(after.getState()).toMatchObject({ phase: 'recording', materialId, sessionId, failure: null, startError: null });
    expect(routes()).toContain(`POST /kb/recordings/${materialId}/resume`);
    expect(routes()).toContain(`GET /sessions/${sessionId}/live`);
    expect(eng.started).toMatchObject({ sessionId, sampleRate: 48000 });
    expect(ui.getState().right).toEqual({ kind: 'live', materialId });
  });

  it('continuing a recording the backend refuses says why and starts nothing', async () => {
    const { store, eng } = setup();
    await store.getState().continueRecording('not-a-recording');
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().startError).toMatch(/not a recording/);
    expect(eng.engine.start).not.toHaveBeenCalled();
  });

  it('a failed start says why and leaves nothing recording', async () => {
    const { store, eng } = setup();
    vi.mocked(eng.engine.start).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await store.getState().start();
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().startError).toMatch(/Microphone access was denied/);
  });

  it('quit barrier: stops a running recording and answers whether its audio is saved', async () => {
    const { store, eng } = setup();
    await expect(store.getState().prepareQuit()).resolves.toBe(true);
    await store.getState().start();
    eng.unsaved();
    await expect(store.getState().prepareQuit()).resolves.toBe(false);
    expect(store.getState().phase).toBe('finishing');
  });

  it('quit barrier: a flush that never confirmed stops and settles, but does not let SKAZ quit silently', async () => {
    const { store, eng, routes } = setup();
    await store.getState().start();
    const id = store.getState().materialId!;
    eng.flushUnconfirmed();
    await expect(store.getState().prepareQuit()).resolves.toBe(false);
    // Everything received is delivered and the material settled; only the last moment is unknown.
    expect(store.getState().phase).toBe('idle');
    expect(routes()).toContain(`POST /kb/recordings/${id}/stop`);
    expect(store.getState().startError).toMatch(/last moment of audio/);
    // Nothing is left to save: a second quit is the user's informed choice.
    await expect(store.getState().prepareQuit()).resolves.toBe(true);
  });

  it('without a capture pipeline (no native bridge) Record explains instead of pretending', async () => {
    const fake = createFakeBridge(docWorld());
    const store = createRecordingStore({ client: new KbClient(fake.bridge), bridge: fake.bridge, ui: createUiStore(), capture: null, sleep: async () => undefined });
    await store.getState().start();
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().startError).toMatch(/isn’t available/);
  });
});
