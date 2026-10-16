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
    onCancelQuit: vi.fn(),
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
    expect(f.deps.onCancelQuit).toHaveBeenCalledTimes(1);
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
