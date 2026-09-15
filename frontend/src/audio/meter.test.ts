import { describe, it, expect } from 'vitest';
import { FLOOR_DBFS, SignalMeter, linearToDbfs } from './meter';

// Controllable clock: the meter must key its window/throttle/hold timers off
// injected time, not real wall-clock, so tests are deterministic.
function fakeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('linearToDbfs', () => {
  it('maps full scale to 0 dBFS and clamps silence at the floor, without amplifying', () => {
    expect(linearToDbfs(1)).toBeCloseTo(0, 5);
    expect(linearToDbfs(0.5)).toBeCloseTo(-6.0206, 3);
    expect(linearToDbfs(0)).toBe(FLOOR_DBFS);
    expect(linearToDbfs(-1)).toBe(FLOOR_DBFS);
  });
});

describe('SignalMeter — throttled ~10Hz emission independent of frame size', () => {
  it('emits on the first sample, then withholds until ~100ms have passed', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    expect(meter.push(0.1, 0.1, 10, 1_000)).not.toBeNull();

    clock.advance(20);
    expect(meter.push(0.1, 0.1, 10, 1_000)).toBeNull(); // still inside the throttle window

    clock.advance(50);
    expect(meter.push(0.1, 0.1, 10, 1_000)).toBeNull(); // 70ms total, still under 100ms

    clock.advance(40);
    expect(meter.push(0.1, 0.1, 10, 1_000)).not.toBeNull(); // 110ms total, throttle allows a new emission
  });

  it('does not depend on how many frames land inside the window', () => {
    const clock = fakeClock();
    const manyTinyFrames = new SignalMeter(clock.now);
    for (let i = 0; i < 50; i += 1) {
      manyTinyFrames.push(0.2, 0.2, 1, 1_000);
      clock.advance(1);
    }
    const fromManyFrames = manyTinyFrames.peekSnapshot();

    const clock2 = fakeClock();
    const fewFrames = new SignalMeter(clock2.now);
    fewFrames.push(0.2, 0.2, 25, 1_000);
    clock2.advance(25);
    fewFrames.push(0.2, 0.2, 25, 1_000);
    const fromFewFrames = fewFrames.peekSnapshot();

    expect(fromManyFrames.dbfs).toBeCloseTo(fromFewFrames.dbfs, 1);
  });

  it('weights RMS energy by sample count when frame sizes differ', () => {
    const meter = new SignalMeter(() => 0);
    meter.push(1, 1, 1, 1_000);
    meter.push(0, 0, 3, 1_000);

    expect(meter.peekSnapshot().dbfs).toBeCloseTo(linearToDbfs(0.5), 5);
  });

  it('bounds buffered frames even when wall time does not advance', () => {
    const meter = new SignalMeter(() => 0);
    for (let i = 0; i < 10_000; i += 1) meter.push(0.1, 0.1, 1, 48_000);

    expect(meter.bufferedFrameCount()).toBeLessThanOrEqual(2_048);
  });
});

describe('SignalMeter — peak clipping', () => {
  it('flags real full-scale peaks and holds the flag briefly, then clears', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.1, 0.1, 10, 1_000);
    expect(meter.peekSnapshot().clipping).toBe(false);

    meter.push(0.2, 0.99, 10, 1_000); // a genuine near-full-scale peak sample
    expect(meter.peekSnapshot().clipping).toBe(true);

    clock.advance(1_000);
    meter.push(0.1, 0.1, 1_000, 1_000);
    expect(meter.peekSnapshot().clipping).toBe(true); // still within the hold window

    clock.advance(600);
    meter.push(0.1, 0.1, 600, 1_000); // 1600ms of audio since the clip, past the hold window
    expect(meter.peekSnapshot().clipping).toBe(false);
  });

  it('does not advance the clipping hold during a wall-clock delivery stall', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.2, 0.99, 10, 1_000);
    clock.advance(10_000);

    expect(meter.peekSnapshot().clipping).toBe(true);
  });

  it('never reports clipping for ordinary loud-but-unclipped audio', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.6, 0.85, 10, 1_000);
    expect(meter.peekSnapshot().clipping).toBe(false);
  });
});

describe('SignalMeter — sustained low level vs momentary pause', () => {
  it('does not warn for a brief pause between words', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.3, 0.3, 10, 1_000); // normal speech level
    meter.push(0.0005, 0.0005, 10, 1_000); // a short quiet gap
    clock.advance(500);
    expect(meter.push(0.0005, 0.0005, 500, 1_000)!.sustainedLow).toBe(false);
    clock.advance(200);
    meter.push(0.3, 0.3, 200, 1_000); // speech resumes before the sustained threshold
    expect(meter.peekSnapshot().sustainedLow).toBe(false);
  });

  it('warns only once the level stays low continuously past the sustained threshold', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.0005, 0.0005, 1, 1_000);
    clock.advance(2_999);
    expect(meter.push(0.0005, 0.0005, 2_998, 1_000)!.sustainedLow).toBe(false);
    clock.advance(2);
    meter.push(0.0005, 0.0005, 2, 1_000); // may be throttled; read state via peekSnapshot regardless
    expect(meter.peekSnapshot().sustainedLow).toBe(true);
  });

  it('does not turn a delivery stall into three seconds of quiet audio', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.0005, 0.0005, 10, 1_000);
    clock.advance(4_000);

    expect(meter.push(0.0005, 0.0005, 10, 1_000)!.sustainedLow).toBe(false);
  });

  it('never labels the sustained-low signal as speech detection', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.0005, 0.0005, 3_100, 1_000);
    clock.advance(3_100);
    const snap = meter.peekSnapshot();
    expect(snap.sustainedLow).toBe(true);
    expect(snap.vad).toBe('unavailable');
  });
});

describe('SignalMeter — reset on lifecycle transitions', () => {
  it('clears the window on reset', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.9, 0.9, 10, 1_000);
    clock.advance(50);
    expect(meter.reset().dbfs).toBe(FLOOR_DBFS);
  });

  it('clears a recent clip flag on reset so lifecycle state cannot stay stale', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.9, 0.99, 10, 1_000); // clip right before pausing
    clock.advance(50);

    expect(meter.reset().clipping).toBe(false);
  });

  it('clears the sustained-low timer on reset so a resumed low signal needs its own full duration', () => {
    const clock = fakeClock();
    const meter = new SignalMeter(clock.now);
    meter.push(0.0005, 0.0005, 2_500, 1_000);
    clock.advance(2_500); // most of the way to the sustained threshold
    meter.push(0.0005, 0.0005, 1, 1_000);

    meter.reset();

    clock.advance(1); // low signal resumes just after the reset
    expect(meter.push(0.0005, 0.0005, 1, 1_000)!.sustainedLow).toBe(false); // timer re-anchored here

    clock.advance(2_999);
    expect(meter.push(0.0005, 0.0005, 2_998, 1_000)!.sustainedLow).toBe(false); // just under 3000ms since the reset-anchored onset

    clock.advance(2);
    meter.push(0.0005, 0.0005, 2, 1_000); // may be throttled; read state via peekSnapshot regardless
    expect(meter.peekSnapshot().sustainedLow).toBe(true); // crossed 3000ms since reset, not since the original onset
  });

  it('always reports an explicit not-available VAD status; nothing infers speech from amplitude', () => {
    const meter = new SignalMeter(() => 0);
    expect(meter.reset().vad).toBe('unavailable');
    expect(meter.push(0.5, 0.5, 10, 1_000)!.vad).toBe('unavailable');
  });
});
