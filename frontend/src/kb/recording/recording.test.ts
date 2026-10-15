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
  const engine: CaptureEngine = {
    start: vi.fn(async (start, cb) => { started = start; callbacks = cb; calls.push('start'); }),
    pause: vi.fn(async () => { calls.push('pause'); }),
    resume: vi.fn(async () => { calls.push('resume'); }),
    stop: vi.fn(async () => { calls.push('stop'); return saved; }),
    elapsedMs: () => elapsed,
    pending: () => ({ pending: saved ? 0 : 3, failed: 0 }),
  };
  return {
    engine, calls,
    get started() { return started; },
    level: (dbfs: number) => callbacks!.onLevel({ dbfs, peakDbfs: dbfs + 6, clipping: false }),
    fail: (message: string) => callbacks!.onFailure(message),
    setElapsed: (ms: number) => { elapsed = ms; },
    unsaved: () => { saved = false; },
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

  it('without a capture pipeline (no native bridge) Record explains instead of pretending', async () => {
    const fake = createFakeBridge(docWorld());
    const store = createRecordingStore({ client: new KbClient(fake.bridge), bridge: fake.bridge, ui: createUiStore(), capture: null, sleep: async () => undefined });
    await store.getState().start();
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().startError).toMatch(/isn’t available/);
  });
});
