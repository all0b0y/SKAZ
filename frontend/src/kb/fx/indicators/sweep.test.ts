import { describe, expect, it } from 'vitest';
import { CALL_SWEEP_SPEED, callSweepDot, callSweepPoints, drawCallSweep } from './sweep';
import { stripBandX } from '../stipple/stipple';

// Stage 6 B3: the running tool-call chip's fill is the production Stippling strip (C2), quieter.
describe('call chip sweep', () => {
  it('dots are nearly invisible at rest and light up inside the band, never fully opaque', () => {
    expect(callSweepDot(0)).toEqual({ radius: 0.8, alpha: 0.06 });
    expect(callSweepDot(1).alpha).toBeCloseTo(0.48);
    expect(callSweepDot(1).radius).toBeCloseTo(1.2);
  });

  it('draws one dot per point, the band moving 1.4× the progress strip; no context = no work', () => {
    const pts = callSweepPoints(200, 26);
    expect(pts.length).toBeGreaterThan(80);
    const fills: string[] = [];
    const ctx = { set fillStyle(v: string) { fills.push(v); }, beginPath() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D;
    drawCallSweep(ctx, pts, 200, 1, { ink: [0, 0, 0], accent: [255, 0, 0] });
    expect(fills).toHaveLength(pts.length);
    expect(stripBandX(1 * CALL_SWEEP_SPEED, 200)).not.toBe(stripBandX(1, 200));
    expect(() => drawCallSweep(null, pts, 200, 1, { ink: [0, 0, 0], accent: [0, 0, 0] })).not.toThrow();
  });
});
