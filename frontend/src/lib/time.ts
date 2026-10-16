// Timecode formatting for transcript citations. Times are recording-timeline
// milliseconds (pauses excluded).

const pad2 = (n: number): string => n.toString().padStart(2, '0');

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
