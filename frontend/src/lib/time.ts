// Timecode formatting for transcript rows, citations, and the recorder clock.
// Times are recording-timeline milliseconds (pauses excluded).

/** Explicit context windows in minutes (docs/PRODUCT.md #4). 5 is the default. */
export const WINDOW_PRESETS = [2, 5, 10] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];
export const DEFAULT_WINDOW_MINUTES: WindowPreset = 5;

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Local wall-clock title; stable date/minute format regardless of OS locale. */
export function defaultSessionTitle(date = new Date()): string {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format milliseconds as mm:ss, or h:mm:ss once past an hour. */
export function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Format a start–end span as two timecodes joined by an en dash. */
export function formatRange(startMs: number, endMs: number): string {
  return `${formatTimecode(startMs)}–${formatTimecode(endMs)}`;
}
