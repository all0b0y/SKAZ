import { describe, expect, it, vi } from 'vitest';
import { QuitController } from '../../../electron/quitController';

function fixture() {
  let resolve!: (saved: boolean) => void;
  const saving = new Promise<boolean>((done) => { resolve = done; });
  const deps = {
    hasUnsentAudio: () => true,
    saveBeforeQuit: vi.fn(() => saving),
    confirmDiscard: vi.fn(() => false),
    stopBackend: vi.fn(async () => undefined),
    quit: vi.fn(),
  };
  return { controller: new QuitController(deps), deps, resolve };
}

describe('save-on-quit lifecycle', () => {
  it('blocks repeated quit and close while saving and stops backend only after the save ACK', async () => {
    const f = fixture();
    expect(f.controller.onBeforeQuit()).toBe(true);
    expect(f.deps.saveBeforeQuit).toHaveBeenCalledTimes(1);
    expect(f.controller.onBeforeQuit()).toBe(true);
    expect(f.controller.onWindowClose()).toBe(true);
    expect(f.deps.confirmDiscard).not.toHaveBeenCalled();
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    f.resolve(true);
    await f.controller.settled();
    expect(f.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
    expect(f.controller.onBeforeQuit()).toBe(false);
  });

  it('keeps renderer and backend alive after a failed save unless discard is explicitly confirmed', async () => {
    const f = fixture();
    f.controller.onWindowClose();
    f.resolve(false);
    await f.controller.settled();
    expect(f.deps.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    expect(f.deps.quit).not.toHaveBeenCalled();
    expect(f.controller.isShuttingDown).toBe(false);
  });

  it('offers explicit discard on a rejected save and does not silently authorize the next quit', async () => {
    const f = fixture();
    f.deps.saveBeforeQuit.mockRejectedValue(new Error('renderer unavailable'));
    f.controller.onBeforeQuit();
    await f.controller.settled();
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    f.deps.confirmDiscard.mockReturnValue(true);
    f.controller.onBeforeQuit();
    await f.controller.settled();
    expect(f.deps.saveBeforeQuit).toHaveBeenCalledTimes(2);
    expect(f.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
  });
});

// The user's rule: SKAZ is gone from the screen within 200 ms of a close. With no audio at risk the window
// hides at once and saving + stopping the backend finish unseen; with audio at risk it stays as before.
describe('the window leaves at once when nothing is at risk', () => {
  function quiet(unsent = false) {
    const f = fixture();
    const order: string[] = [];
    const deps = {
      ...f.deps,
      hasUnsentAudio: () => unsent,
      hideWindow: vi.fn(() => { order.push('hide'); }),
      showWindow: vi.fn(() => { order.push('show'); }),
      confirmDiscard: vi.fn(() => { order.push('confirm'); return false; }),
    };
    return { controller: new QuitController(deps), deps, resolve: f.resolve, order };
  }

  it.each(['close', 'quit'] as const)('hides synchronously on %s, before the save ACK, then quits', async (how) => {
    const f = quiet();
    if (how === 'close') f.controller.onWindowClose(); else f.controller.onBeforeQuit();
    expect(f.deps.hideWindow).toHaveBeenCalledTimes(1);
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    f.resolve(true);
    await f.controller.settled();
    expect(f.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
    expect(f.deps.showWindow).not.toHaveBeenCalled();
  });

  it('brings the window back before the warning when the save fails', async () => {
    const f = quiet();
    f.controller.onWindowClose();
    f.resolve(false);
    await f.controller.settled();
    expect(f.order).toEqual(['hide', 'show', 'confirm']);
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
  });

  it('keeps the window while audio is at risk (recording, processing, pending or failed)', async () => {
    const f = quiet(true);
    f.controller.onWindowClose();
    f.resolve(true);
    await f.controller.settled();
    expect(f.deps.hideWindow).not.toHaveBeenCalled();
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
  });
});

// The user's rule: a fast relaunch (Dock click, second launch) while the hidden window is still shutting down
// must not be lost, and the new SKAZ may start only after this one — backend included — has fully exited.
describe('a launch during the shutdown relaunches after the old process is gone', () => {
  function relaunching() {
    const f = fixture();
    const order: string[] = [];
    const deps = {
      ...f.deps,
      hasUnsentAudio: () => false,
      stopBackend: vi.fn(async () => { order.push('stop'); }),
      relaunch: vi.fn(() => { order.push('relaunch'); }),
      quit: vi.fn(() => { order.push('quit'); }),
      confirmDiscard: vi.fn(() => false),
    };
    return { controller: new QuitController(deps), deps, resolve: f.resolve, order };
  }

  it('is not consumed while running: the caller shows the window as before', () => {
    const f = relaunching();
    expect(f.controller.onLaunchRequest()).toBe(false);
    expect(f.deps.relaunch).not.toHaveBeenCalled();
  });

  it('while saving: relaunch once, only after the backend has stopped, right before the quit', async () => {
    const f = relaunching();
    f.controller.onWindowClose();
    expect(f.controller.onLaunchRequest()).toBe(true);
    expect(f.controller.onLaunchRequest()).toBe(true);
    expect(f.deps.relaunch).not.toHaveBeenCalled();
    f.resolve(true);
    await f.controller.settled();
    expect(f.order).toEqual(['stop', 'relaunch', 'quit']);
  });

  it('after the shutdown settled (window tearing down): relaunch at once, still only once', async () => {
    const f = relaunching();
    f.controller.onBeforeQuit();
    f.resolve(true);
    await f.controller.settled();
    expect(f.controller.onLaunchRequest()).toBe(true);
    expect(f.controller.onLaunchRequest()).toBe(true);
    expect(f.deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('a cancelled quit (failed save, user stays) drops the relaunch: the window is simply back', async () => {
    const f = relaunching();
    f.controller.onWindowClose();
    f.controller.onLaunchRequest();
    f.resolve(false);
    await f.controller.settled();
    expect(f.deps.relaunch).not.toHaveBeenCalled();
    expect(f.deps.quit).not.toHaveBeenCalled();
    expect(f.controller.onLaunchRequest()).toBe(false);
  });
});
