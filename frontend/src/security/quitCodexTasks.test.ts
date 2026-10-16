import { describe, expect, it, vi } from 'vitest';
import { QuitController } from '../../../electron/quitController';
import { validateCodexActivity } from '../../../electron/ipcSender';

// Quit with active Codex tasks: "Stay" / "Stop tasks and quit"
// (CODEX-ASSISTANT-SPEC §8). The warning comes before any save or shutdown.

function harness(active: boolean, stopAndQuit: boolean) {
  const events: string[] = [];
  const deps = {
    saveBeforeQuit: vi.fn(async () => { events.push('save'); return true; }),
    onCancelQuit: vi.fn(),
    hasUnsentAudio: vi.fn(() => false),
    confirmDiscard: vi.fn(() => true),
    stopBackend: vi.fn(async () => { events.push('stop'); }),
    quit: vi.fn(() => { events.push('quit'); }),
    hasActiveTasks: vi.fn(() => active),
    confirmStopTasks: vi.fn(() => { events.push('ask-tasks'); return stopAndQuit; }),
  };
  return { controller: new QuitController(deps), deps, events };
}

describe('QuitController — active Codex tasks', () => {
  it('"Stay" blocks the quit before anything is saved or stopped', () => {
    const h = harness(true, false);
    expect(h.controller.onBeforeQuit()).toBe(true);
    expect(h.events).toEqual(['ask-tasks']);
    expect(h.deps.saveBeforeQuit).not.toHaveBeenCalled();
    expect(h.deps.stopBackend).not.toHaveBeenCalled();
    // A second attempt asks again: staying is not remembered as consent.
    h.controller.onWindowClose();
    expect(h.deps.confirmStopTasks).toHaveBeenCalledTimes(2);
  });

  it('"Stop tasks and quit" proceeds through the normal save and shutdown once', async () => {
    const h = harness(true, true);
    expect(h.controller.onBeforeQuit()).toBe(true);
    await h.controller.settled();
    await h.controller.settled();
    expect(h.events).toEqual(['ask-tasks', 'save', 'stop', 'quit']);
    expect(h.controller.onBeforeQuit()).toBe(false);
    expect(h.deps.confirmStopTasks).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when no task is active', async () => {
    const h = harness(false, false);
    h.controller.onBeforeQuit();
    await h.controller.settled();
    await h.controller.settled();
    expect(h.deps.confirmStopTasks).not.toHaveBeenCalled();
    expect(h.events).toEqual(['save', 'stop', 'quit']);
  });

  it('accepts only a bounded integer task count from the renderer', () => {
    expect(validateCodexActivity(2)).toBe(2);
    expect(validateCodexActivity(0)).toBe(0);
    for (const bad of [-1, 1.5, '3', null, {}, 10_000_001]) expect(validateCodexActivity(bad)).toBeNull();
  });
});
