import { describe, expect, it, vi } from 'vitest';
import { RendererSaveBarrier } from '../../../electron/rendererSaveBarrier';

describe('renderer save handshake', () => {
  it('shares one bounded request, ignores stale acknowledgements and fails closed on timeout', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const barrier = new RendererSaveBarrier(send, 100);
      const first = barrier.request();
      expect(barrier.request()).toBe(first);
      const id = send.mock.calls[0]![0] as number;
      barrier.acknowledge(id + 1, true);
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toBe(false);
      const second = barrier.request();
      barrier.acknowledge(id, true);
      barrier.acknowledge(send.mock.calls[1]![0], true);
      await expect(second).resolves.toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('fails safely if sending throws or the renderer disappears', async () => {
    const broken = new RendererSaveBarrier(() => { throw new Error('gone'); });
    await expect(broken.request()).resolves.toBe(false);
    const barrier = new RendererSaveBarrier(vi.fn());
    const saving = barrier.request();
    barrier.disconnected();
    await expect(saving).resolves.toBe(false);
  });
});
