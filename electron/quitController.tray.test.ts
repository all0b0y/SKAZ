import { describe, expect, it, vi } from 'vitest';
import { QuitController, type QuitDeps } from './quitController';
import { TrayBehavior, type TrayPrefs } from './trayBehavior';

// Decision 3f′: closing the window keeps SKAZ in the tray; only Quit (tray menu, Cmd+Q) quits, and that quit
// keeps every guarantee of the quit controller — including when the window is hidden in the tray at the time.

function fixture(options: { unsent?: boolean; closeQuits?: boolean; saved?: boolean; discard?: boolean } = {}) {
  const order: string[] = [];
  const state = { unsent: options.unsent ?? false, saved: options.saved ?? true, discard: options.discard ?? false };
  let release: () => void = () => undefined;
  const prefs: TrayPrefs = { closeQuits: options.closeQuits ?? false, hintShown: false };
  const tray = new TrayBehavior({
    prefs: { read: () => ({ ...prefs }), write: (next) => { Object.assign(prefs, next); return true; } },
    trayAvailable: () => true,
    hide: () => { order.push('tray-hide'); },
    showHint: () => { order.push('hint'); return true; },
  });
  const deps = {
    saveBeforeQuit: vi.fn(async () => { order.push('save'); return state.saved; }),
    hasUnsentAudio: vi.fn(() => state.unsent),
    confirmDiscard: vi.fn(() => { order.push('confirm'); return state.discard; }),
    stopBackend: vi.fn(() => new Promise<void>((resolve) => { order.push('stop'); release = resolve; })),
    quit: vi.fn(() => { order.push('quit'); }),
    hideWindow: vi.fn(() => { order.push('hide'); }),
    showWindow: vi.fn(() => { order.push('show'); }),
    relaunch: vi.fn(),
    closeToTray: () => tray.onWindowClose(),
  } satisfies QuitDeps;
  return { controller: new QuitController(deps), deps, order, state, prefs, tray, releaseStop: () => release() };
}

/** Let the save promise (a resolved async) reach the stop or the warning. */
const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('closing the window', () => {
  it('by default hides to the tray: close prevented, nothing saved, stopped or quit', async () => {
    const f = fixture();
    expect(f.controller.onWindowClose()).toBe(true);
    await tick();
    expect(f.order).toEqual(['tray-hide', 'hint']);
    expect(f.deps.saveBeforeQuit).not.toHaveBeenCalled();
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    expect(f.deps.quit).not.toHaveBeenCalled();
    expect(f.controller.isShuttingDown).toBe(false);
  });

  it('with audio at risk still only hides: nothing is lost, so no warning and the recording goes on', async () => {
    const f = fixture({ unsent: true });
    expect(f.controller.onWindowClose()).toBe(true);
    await tick();
    expect(f.deps.confirmDiscard).not.toHaveBeenCalled();
    expect(f.deps.saveBeforeQuit).not.toHaveBeenCalled();
    expect(f.order).toContain('tray-hide');
  });

  it('with "Closing the window quits SKAZ" on is the old full quit, without touching the tray', async () => {
    const f = fixture({ closeQuits: true });
    expect(f.controller.onWindowClose()).toBe(true);
    await tick();
    f.releaseStop();
    await f.controller.settled();
    expect(f.order).toEqual(['hide', 'save', 'stop', 'quit']);
    expect(f.controller.onWindowClose()).toBe(false); // the real close of the real quit goes through
  });

  it('with the toggle on keeps the old warning: cancel keeps the backend', async () => {
    const f = fixture({ closeQuits: true, unsent: true, saved: false, discard: false });
    expect(f.controller.onWindowClose()).toBe(true);
    await f.controller.settled();
    expect(f.deps.confirmDiscard).toHaveBeenCalledTimes(1);
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    expect(f.deps.quit).not.toHaveBeenCalled();
  });
});

describe.each(['Quit from the tray', 'Cmd+Q'])('%s (both are app before-quit) from the tray', () => {
  it('quits fully even though closing hides: save → stop → quit, and the final close is not hidden again', async () => {
    const f = fixture();
    f.controller.onWindowClose();
    f.order.length = 0;
    expect(f.controller.onBeforeQuit()).toBe(true);
    await tick();
    f.releaseStop();
    await f.controller.settled();
    expect(f.order).toEqual(['hide', 'save', 'stop', 'quit']);
    expect(f.controller.onWindowClose()).toBe(false);
    expect(f.controller.onBeforeQuit()).toBe(false);
    expect(f.order).not.toContain('tray-hide');
  });

  it('with audio at risk brings the window back BEFORE saving: the at-risk rule keeps it on screen', () => {
    const f = fixture({ unsent: true });
    f.controller.onWindowClose();
    f.order.length = 0;
    f.controller.onBeforeQuit();
    expect(f.order.indexOf('show')).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf('show')).toBeLessThan(f.order.indexOf('save'));
    expect(f.deps.hideWindow).not.toHaveBeenCalled();
  });

  it('never opens the warning over a hidden window (a sheet on it would hang SKAZ unseen)', async () => {
    for (const unsent of [true, false]) {
      const f = fixture({ unsent, saved: false });
      f.controller.onWindowClose();
      f.order.length = 0;
      f.controller.onBeforeQuit();
      await f.controller.settled();
      const confirmAt = f.order.indexOf('confirm');
      expect(confirmAt).toBeGreaterThan(0);
      expect(f.order[confirmAt - 1]).toBe('show');
    }
  });

  it('a cancelled warning keeps the backend, and the next close hides to the tray again', async () => {
    const f = fixture({ unsent: true, saved: false, discard: false });
    f.controller.onBeforeQuit();
    await f.controller.settled();
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
    expect(f.deps.quit).not.toHaveBeenCalled();
    f.order.length = 0;
    expect(f.controller.onWindowClose()).toBe(true);
    await tick();
    expect(f.order[0]).toBe('tray-hide');
    expect(f.deps.saveBeforeQuit).toHaveBeenCalledTimes(1);
  });

  it('a cancelled warning does not authorize the next quit', async () => {
    const f = fixture({ unsent: true, saved: false, discard: false });
    f.controller.onBeforeQuit();
    await f.controller.settled();
    f.controller.onBeforeQuit();
    await f.controller.settled();
    expect(f.deps.confirmDiscard).toHaveBeenCalledTimes(2);
    expect(f.deps.stopBackend).not.toHaveBeenCalled();
  });

  it('discarding in the warning goes on to stop and quit', async () => {
    const f = fixture({ unsent: true, saved: false, discard: true });
    f.controller.onBeforeQuit();
    await tick();
    f.releaseStop();
    await f.controller.settled();
    expect(f.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
  });
});

describe('reentry', () => {
  it('a close while saving is blocked and neither hides to the tray nor shows the hint', () => {
    const f = fixture();
    f.controller.onBeforeQuit();
    f.order.length = 0;
    expect(f.controller.onWindowClose()).toBe(true);
    expect(f.order).toEqual([]);
    expect(f.prefs.hintShown).toBe(false);
  });

  it('repeated quits while saving and draining run one save and one stop; quit waits for the stop', async () => {
    const f = fixture();
    f.controller.onBeforeQuit();
    expect(f.controller.onBeforeQuit()).toBe(true);
    await tick();
    expect(f.deps.stopBackend).toHaveBeenCalledTimes(1);
    expect(f.controller.onBeforeQuit()).toBe(true);
    expect(f.controller.onWindowClose()).toBe(true);
    expect(f.deps.quit).not.toHaveBeenCalled();
    f.releaseStop();
    await f.controller.settled();
    expect(f.deps.saveBeforeQuit).toHaveBeenCalledTimes(1);
    expect(f.deps.quit).toHaveBeenCalledTimes(1);
    expect(f.order).not.toContain('tray-hide');
  });

  it('Open SKAZ during the unseen shutdown is a launch: consumed, relaunched once after the stop', async () => {
    const f = fixture();
    f.controller.onBeforeQuit();
    expect(f.controller.onLaunchRequest()).toBe(true);
    await tick();
    expect(f.deps.relaunch).not.toHaveBeenCalled();
    f.releaseStop();
    await f.controller.settled();
    expect(f.deps.relaunch).toHaveBeenCalledTimes(1);
  });

  it('Open SKAZ from the tray while simply running is not consumed: the caller shows the window', () => {
    const f = fixture();
    f.controller.onWindowClose();
    expect(f.controller.onLaunchRequest()).toBe(false);
  });
});

describe('a controller without a tray', () => {
  it('behaves exactly as before: no closeToTray dep, close is the old path', () => {
    const deps = {
      hasUnsentAudio: () => false, confirmDiscard: () => false, stopBackend: async () => undefined, quit: () => undefined,
    };
    expect(new QuitController(deps).onWindowClose()).toBe(false);
  });

  it('a warning without saveBeforeQuit also brings the window back first', () => {
    const order: string[] = [];
    const controller = new QuitController({
      hasUnsentAudio: () => true,
      confirmDiscard: () => { order.push('confirm'); return false; },
      stopBackend: async () => undefined,
      quit: () => undefined,
      showWindow: () => { order.push('show'); },
    });
    controller.onBeforeQuit();
    expect(order).toEqual(['show', 'confirm']);
  });
});
