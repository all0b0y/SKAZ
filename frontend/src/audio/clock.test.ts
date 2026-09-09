import { describe, it, expect } from 'vitest';
import { RecordingClock, SampleTimeline } from './clock';

describe('SampleTimeline', () => {
  it('uses delivered sample counts instead of delayed wall-clock messages', () => {
    const timeline = new SampleTimeline(48_000);
    timeline.accept(48_000);
    expect(timeline.rangeFor(48_000)).toEqual({ startMs: 0, endMs: 1_000 });
    // A worklet message may arrive much later than capture; its wall-clock
    // delivery time must not stretch or overlap the audio timeline.
    timeline.accept(24_000);
    expect(timeline.elapsedMs()).toBe(1_500);
    expect(timeline.rangeFor(24_000)).toEqual({ startMs: 1_000, endMs: 1_500 });
  });

  it('stays contiguous across a pause/resume boundary', () => {
    const timeline = new SampleTimeline(16_000);
    timeline.accept(8_000);
    expect(timeline.rangeFor(8_000)).toEqual({ startMs: 0, endMs: 500 });
    timeline.accept(4_000);
    expect(timeline.rangeFor(4_000)).toEqual({ startMs: 500, endMs: 750 });
  });
});

describe('RecordingClock', () => {
  it('starts at zero and advances with wall time while recording', () => {
    let now = 1000;
    const clock = new RecordingClock(() => now);
    clock.start();
    expect(clock.elapsedMs()).toBe(0);
    now = 4000;
    expect(clock.elapsedMs()).toBe(3000);
    expect(clock.state).toBe('recording');
  });

  it('excludes paused wall time from the recording timeline', () => {
    let now = 0;
    const clock = new RecordingClock(() => now);
    clock.start();
    now = 5000; // recorded 5s
    clock.pause();
    now = 20000; // 15s of paused wall time
    expect(clock.elapsedMs()).toBe(5000);
    expect(clock.state).toBe('paused');
    clock.resume();
    now = 23000; // +3s recorded
    expect(clock.elapsedMs()).toBe(8000);
  });

  it('accumulates across multiple pause/resume cycles', () => {
    let now = 100;
    const clock = new RecordingClock(() => now);
    clock.start();
    now = 1100; // +1000
    clock.pause();
    now = 5100; // paused 4000
    clock.resume();
    now = 5600; // +500
    clock.pause();
    now = 9600; // paused 4000
    clock.resume();
    now = 9900; // +300
    expect(clock.elapsedMs()).toBe(1800);
  });

  it('freezes the timeline after stop', () => {
    let now = 0;
    const clock = new RecordingClock(() => now);
    clock.start();
    now = 7000;
    clock.stop();
    expect(clock.elapsedMs()).toBe(7000);
    now = 99999;
    expect(clock.elapsedMs()).toBe(7000);
    expect(clock.state).toBe('stopped');
  });

  it('reports zero before start', () => {
    const clock = new RecordingClock(() => 500);
    expect(clock.elapsedMs()).toBe(0);
    expect(clock.state).toBe('idle');
  });

  it('is a no-op to pause while already paused or resume while recording', () => {
    let now = 0;
    const clock = new RecordingClock(() => now);
    clock.start();
    now = 1000;
    clock.pause();
    clock.pause();
    now = 3000;
    clock.resume();
    clock.resume();
    now = 4000;
    expect(clock.elapsedMs()).toBe(2000);
  });

  it('returns integer milliseconds', () => {
    let now = 0.0;
    const clock = new RecordingClock(() => now);
    clock.start();
    now = 1234.9;
    expect(Number.isInteger(clock.elapsedMs())).toBe(true);
  });
});
