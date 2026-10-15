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
    // Writes only: the stream-state poll reads the session's live events in between.
    expect(routes().filter((r) => r.includes(id) && !r.startsWith('GET '))).toEqual([
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

  it('while recording it follows the stream state of the session: reconnecting is said, never hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { store, fake } = setup();
      await store.getState().loadOptions();
      await store.getState().start();
      fake.world.liveTranscription = 'reconnecting';
      await vi.advanceTimersByTimeAsync(1600);
      expect(store.getState().stream).toBe('reconnecting');
      expect(store.getState().provider).toBe('soniox');
      expect(store.getState().live?.partial?.text).toBe('So cross-entropy in machine learning is');
      fake.world.liveTranscription = 'streaming';
      await vi.advanceTimersByTimeAsync(1600);
      expect(store.getState().stream).toBe('streaming');
      await store.getState().pause();
      // The stream is gone; the last live text stays until the material holds it (the panel trims it).
      expect(store.getState().stream).toBeNull();
      expect(store.getState().live).not.toBeNull();
      const first = store.getState().materialId;
      await store.getState().resume();
      await store.getState().stop();
      await store.getState().start();
      // A new recording never shows the previous one's live text.
      expect(store.getState().materialId).not.toBe(first);
      await vi.waitFor(() => expect(store.getState().live?.material_id).toBe(store.getState().materialId));
    } finally {
      vi.useRealTimers();
    }
  });

  it('continuous speech with no pause: the open monologue is in the store within one poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { store, fake, routes } = setup();
      fake.world.liveOpen = 'and the entropy keeps growing while the speaker never stops';
      await store.getState().start();
      const id = store.getState().materialId!;
      await vi.advanceTimersByTimeAsync(1600);
      expect(routes()).toContain(`GET /kb/recordings/${id}/live`);
      expect(store.getState().live).toMatchObject({
        material_id: id, after_seg: 0,
        monologues: [{ text: 'and the entropy keeps growing while the speaker never stops' }],
      });
      // Nothing closed: the material itself is still empty.
      expect(fake.world.materials.find((m) => m.id === id)?.fragments).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls one request at a time and asks only for the fragments after the last one it has', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeBridge(docWorld());
      let inFlight = 0;
      let most = 0;
      const slowLive = {
        ...fake.bridge,
        request: async (req: Parameters<typeof fake.bridge.request>[0]) => {
          if (!/^\/kb\/recordings\/[^/]+\/live$/.test(req.path)) return fake.bridge.request(req);
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 4000)); // a backend busy with a scan
          try { return await fake.bridge.request(req); } finally { inFlight -= 1; }
        },
      } as typeof fake.bridge;
      const eng = fakeEngine();
      const store = createRecordingStore({
        client: new KbClient(slowLive), bridge: slowLive, ui: createUiStore(), capture: () => eng.engine,
        sleep: async () => undefined,
      });
      const started = store.getState().start();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      const id = store.getState().materialId!;
      await vi.advanceTimersByTimeAsync(20_000);
      const reads = fake.calls.filter((c) => c.path === `/kb/recordings/${id}/live`);
      expect(most).toBe(1); // the next poll starts 1.5 s after the previous one answered
      expect(reads.length).toBeLessThanOrEqual(Math.ceil(20_000 / 5_500) + 1); // not one per 1.5 s
      // The first poll asks for no fragments; each next one for those after the last answer's after_seg.
      expect(reads[0]!.query).toBeUndefined();
      expect(reads[1]!.query).toEqual({ since_seg: 1 });
      const material = fake.world.materials.find((m) => m.id === id)!;
      const known = material.fragments.filter((f) => f.seg <= store.getState().live!.after_seg && f.seg > 1);
      expect(store.getState().liveFragments.map((f) => f.seg)).toEqual(known.map((f) => f.seg));
      // Nothing reads the whole material while recording.
      expect(fake.calls.some((c) => c.method === 'GET' && c.path === `/kb/materials/${id}`)).toBe(false);
      await store.getState().stop();
    } finally {
      vi.useRealTimers();
    }
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
    expect(store.getState().startErrorWhen).toBe('stop-unsaved');
  });

  it('each refusal says what didn’t happen: start, resume, continue', async () => {
    const { store, eng } = setup();
    vi.mocked(eng.engine.start).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await store.getState().start();
    expect(store.getState().startErrorWhen).toBe('start');
    await store.getState().start();
    await store.getState().pause();
    vi.mocked(eng.engine.resume).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await store.getState().resume();
    expect(store.getState()).toMatchObject({ phase: 'paused', startErrorWhen: 'resume' });
    await store.getState().stop();
    await store.getState().continueRecording('not-a-recording');
    expect(store.getState().startErrorWhen).toBe('continue');
    store.getState().clearStartError();
    expect(store.getState()).toMatchObject({ startError: null, startErrorWhen: null });
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
    expect(store.getState().startErrorWhen).toBe('stop-unconfirmed');
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
