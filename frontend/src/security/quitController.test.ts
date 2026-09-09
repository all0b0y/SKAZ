import { describe, it, expect, vi } from 'vitest';
import { QuitController, type QuitDeps } from '../../../electron/quitController';

interface Harness {
  controller: QuitController;
  events: string[];
  hasUnsent: { value: boolean };
  confirm: { value: boolean };
  resolveStop: () => void;
  rejectStop: (err: unknown) => void;
  deps: { [K in keyof Required<QuitDeps>]: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: { hasUnsent?: boolean; confirm?: boolean } = {}): Harness {
  const events: string[] = [];
  const hasUnsent = { value: opts.hasUnsent ?? false };
  const confirm = { value: opts.confirm ?? false };
  let resolveStop = (): void => undefined;
  let rejectStop = (_err: unknown): void => undefined;

  const deps = {
    hasUnsentAudio: vi.fn(() => hasUnsent.value),
    confirmDiscard: vi.fn(() => {
      events.push('confirm');
      return confirm.value;
    }),
    stopBackend: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          events.push('stop');
          resolveStop = () => resolve();
          rejectStop = (err: unknown) => reject(err);
        }),
    ),
    quit: vi.fn(() => {
      events.push('quit');
    }),
    onShutdownError: vi.fn((err: unknown) => {
      events.push(`error:${String(err)}`);
    }),
  };

  const controller = new QuitController(deps as unknown as QuitDeps);
  return {
    controller,
    events,
    hasUnsent,
    confirm,
    resolveStop: () => resolveStop(),
    rejectStop: (err: unknown) => rejectStop(err),
    deps,
  };
}

describe('QuitController — Cmd+Q / before-quit orchestration', () => {
  it('authorizes BEFORE shutting down, so cancelling keeps the backend running', async () => {
    const h = makeHarness({ hasUnsent: true, confirm: false });
    const prevent = h.controller.onBeforeQuit();

    expect(prevent).toBe(true); // quit was blocked
    expect(h.deps.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(h.deps.stopBackend).not.toHaveBeenCalled(); // backend untouched on cancel
    expect(h.deps.quit).not.toHaveBeenCalled();
    expect(h.controller.isShuttingDown).toBe(false);
    await h.controller.settled();
    expect(h.events).toEqual(['confirm']);
  });

  it('still prompts on the next quit after a cancellation (no silent authorization)', () => {
    const h = makeHarness({ hasUnsent: true, confirm: false });
    h.controller.onBeforeQuit();
    h.controller.onBeforeQuit();
    expect(h.deps.confirmDiscard).toHaveBeenCalledTimes(2);
  });

  it('on confirm, runs confirm → stopBackend → quit strictly in that order', async () => {
    const h = makeHarness({ hasUnsent: true, confirm: true });
    const prevent = h.controller.onBeforeQuit();
    expect(prevent).toBe(true);
    expect(h.deps.quit).not.toHaveBeenCalled(); // not until stop settles
    h.resolveStop();
    await h.controller.settled();
    expect(h.events).toEqual(['confirm', 'stop', 'quit']);
  });

  it('quits with no dialog when there is no unsent audio', async () => {
    const h = makeHarness({ hasUnsent: false });
    h.controller.onBeforeQuit();
    h.resolveStop();
    await h.controller.settled();
    expect(h.deps.confirmDiscard).not.toHaveBeenCalled();
    expect(h.events).toEqual(['stop', 'quit']);
  });

  it('BLOCKS quit reentry while the shutdown is still draining, then allows it once settled', async () => {
    const h = makeHarness({ hasUnsent: true, confirm: true });
    expect(h.controller.onBeforeQuit()).toBe(true); // confirm + begin drain (stop pending)

    // Backend stop has NOT resolved yet: repeated Cmd+Q must keep being blocked
    // and must not quit the app prematurely.
    expect(h.controller.onBeforeQuit()).toBe(true);
    expect(h.controller.onBeforeQuit()).toBe(true);
    expect(h.deps.quit).not.toHaveBeenCalled();
    expect(h.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(h.deps.confirmDiscard).toHaveBeenCalledTimes(1);

    h.resolveStop();
    await h.controller.settled();
    expect(h.deps.quit).toHaveBeenCalledTimes(1);

    // After the shutdown has settled, the real quit is allowed through.
    expect(h.controller.onBeforeQuit()).toBe(false);
    expect(h.deps.quit).toHaveBeenCalledTimes(1); // controller does not re-quit itself
  });

  it('handles a rejected stopBackend without an unhandled rejection and still quits', async () => {
    const h = makeHarness({ hasUnsent: false });
    h.controller.onBeforeQuit();
    h.rejectStop(new Error('backend refused to stop'));
    await expect(h.controller.settled()).resolves.toBeUndefined(); // no rejection escapes
    expect(h.deps.onShutdownError).toHaveBeenCalledTimes(1);
    expect(h.deps.quit).toHaveBeenCalledTimes(1); // not stuck: still quits
    // A subsequent quit is allowed through (settled, not stuck mid-drain).
    expect(h.controller.onBeforeQuit()).toBe(false);
  });
});

describe('QuitController — window close orchestration', () => {
  it('prevents close and preserves the backend when the user keeps recording', () => {
    const h = makeHarness({ hasUnsent: true, confirm: false });
    const prevent = h.controller.onWindowClose();
    expect(prevent).toBe(true);
    expect(h.deps.stopBackend).not.toHaveBeenCalled();
    expect(h.deps.quit).not.toHaveBeenCalled();
  });

  it('allows close untouched when there is no unsent audio', () => {
    const h = makeHarness({ hasUnsent: false });
    const prevent = h.controller.onWindowClose();
    expect(prevent).toBe(false);
    expect(h.deps.confirmDiscard).not.toHaveBeenCalled();
    expect(h.deps.stopBackend).not.toHaveBeenCalled();
  });

  it('after confirming discard, a follow-up close is allowed without a second dialog', async () => {
    const h = makeHarness({ hasUnsent: true, confirm: true });
    h.controller.onWindowClose(); // confirm + begin shutdown
    const again = h.controller.onWindowClose();
    expect(again).toBe(false); // window may close while the authorized shutdown drains
    h.resolveStop();
    await h.controller.settled();
    expect(h.deps.confirmDiscard).toHaveBeenCalledTimes(1);
  });
});
