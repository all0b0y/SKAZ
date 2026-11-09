// The status line of the tray menu (decision 3f′): what SKAZ is doing in the background. A plain board any
// main-process code can report to, so the tray knows nothing about checks or research tasks:
//
//   import { trayStatus } from './trayStatus';
//   trayStatus.set('weekly-check', 'Checking the library');   // show or update this source's line
//   trayStatus.set('weekly-check', null);                     // done: back to the previous line, or Idle
//
// The menu shows the most recent report. Report states in SKAZ's own words only: the line is visible to anyone
// looking at the screen with the window closed, so no material or chat text.

export const TRAY_IDLE = 'Idle';
const MAX_LINE = 60;

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

export class TrayStatus {
  // Insertion order is report order: the last entry is the most recent report.
  private readonly lines = new Map<string, string>();
  private readonly listeners = new Set<(line: string) => void>();

  /** Report a source's line; null or blank text clears that source. */
  set(source: string, text: string | null): void {
    const before = this.current();
    const line = text === null ? '' : oneLine(text);
    this.lines.delete(source);
    if (line) this.lines.set(source, line);
    const now = this.current();
    if (now === before) return;
    for (const listener of this.listeners) {
      try {
        listener(now);
      } catch (err) {
        console.error('[tray] status listener failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  current(): string {
    return [...this.lines.values()].at(-1) ?? TRAY_IDLE;
  }

  /** Called with the new line whenever it changes. Returns the unsubscribe function. */
  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** The one board of this process: the tray menu reads it, other main-process code reports to it. */
export const trayStatus = new TrayStatus();
