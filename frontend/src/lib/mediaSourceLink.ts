/** Never pass a metadata URL or an arbitrary protocol to the OS browser. */
export function mediaSourceLink(videoId: string | null | undefined, atMs = 0): string | null {
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isFinite(atMs) || atMs < 0) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(atMs / 1000)}s`;
}
