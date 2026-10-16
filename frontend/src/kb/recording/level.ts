import { FLOOR_DBFS, type MeterSnapshot } from '../../audio/meter';

/** Heights 0..1 of the three bars in the recording capsule (decision 28). */
export type Bars = readonly [number, number, number];

export const SILENT_BARS: Bars = [0, 0, 0];

/** Below this the room is silent: bars stand still at their minimum. */
const SILENCE_DBFS = -52;

const norm = (dbfs: number): number => {
  if (!Number.isFinite(dbfs) || dbfs <= SILENCE_DBFS) return 0;
  return Math.min(1, Math.max(0, (dbfs - SILENCE_DBFS) / (0 - SILENCE_DBFS - 6)));
};

/**
 * Three bars from a real meter snapshot only: RMS, peak and their mean. No animation of its own,
 * no random jitter — silence (or no snapshot) gives three still bars.
 */
export function barsFrom(snapshot: MeterSnapshot | null): Bars {
  if (!snapshot || snapshot.dbfs <= FLOOR_DBFS) return SILENT_BARS;
  const rms = norm(snapshot.dbfs);
  const peak = norm(snapshot.peakDbfs);
  if (rms === 0 && peak === 0) return SILENT_BARS;
  const round = (v: number) => Math.round(v * 20) / 20;
  return [round(rms), round(peak), round((rms + peak) / 2)];
}
