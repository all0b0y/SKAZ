import { describe, expect, it, vi } from 'vitest';
import { ContextualSchedulerNotifier } from './contextualScheduler';

describe('ContextualSchedulerNotifier', () => {
  it('keeps one in-flight notification and coalesces a burst to the latest durable ACK', async () => {
    let release!: () => void;
    const advance = vi.fn(async (sequence: number) => {
      if (sequence === 1) await new Promise<void>((resolve) => { release = resolve; });
    });
    const notifier = new ContextualSchedulerNotifier(advance);

    notifier.notify(1);
    await vi.waitFor(() => expect(advance).toHaveBeenCalledWith(1));
    notifier.notify(2);
    notifier.notify(4);
    notifier.notify(3);
    expect(notifier.snapshot()).toMatchObject({ inFlight: 1, pending: 4 });
    release();
    await notifier.idle();

    expect(advance.mock.calls).toEqual([[1], [4]]);
    expect(notifier.snapshot()).toEqual({ inFlight: null, pending: null, error: null });
  });

  it('does not lose the last ACK when capture stops and does not auto-loop after an error', async () => {
    const advance = vi.fn().mockRejectedValueOnce(new Error('decoder busy'));
    const notifier = new ContextualSchedulerNotifier(advance);
    notifier.notify(9);
    await notifier.idle();
    expect(notifier.snapshot()).toEqual({ inFlight: null, pending: 9, error: 'decoder busy' });
    expect(advance).toHaveBeenCalledTimes(1);

    advance.mockResolvedValueOnce(undefined);
    notifier.retry();
    await notifier.idle();
    expect(advance).toHaveBeenCalledTimes(2);
    expect(notifier.snapshot()).toEqual({ inFlight: null, pending: null, error: null });
  });
});
