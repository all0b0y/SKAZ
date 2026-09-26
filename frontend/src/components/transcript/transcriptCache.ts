import { NativeHistory } from './nativeHistory';
import type { NativePart } from './nativeParts';

/** Where the reader stood inside one part: scroll offset and opened originals. */
export interface ReadingPlace {
  top: number;
  open: Set<string>;
}

/**
 * Everything needed to show a session's transcript again without re-reading
 * its history. Old events are append-only, so a return only needs the delta.
 */
export interface TranscriptEntry {
  history: NativeHistory;
  /** The full history load finished; before that the entry is only a resume point. */
  ready: boolean;
  parts: NativePart[];
  selectedPartId: string | null;
  publishedRevision: number;
  follow: boolean;
  places: Map<string, ReadingPlace>;
}

/** The current session and the one before it (renderer memory only, never disk). */
const LIMIT = 2;
const entries = new Map<string, TranscriptEntry>();

/** The session's entry, created on first use and marked most recently opened. */
export function openTranscript(sessionId: string): TranscriptEntry {
  const entry = entries.get(sessionId) ?? { history: new NativeHistory(), ready: false, parts: [],
    selectedPartId: null, publishedRevision: -1, follow: true, places: new Map() };
  entries.delete(sessionId);
  entries.set(sessionId, entry);
  for (const id of entries.keys()) {
    if (entries.size <= LIMIT) break;
    entries.delete(id);
  }
  return entry;
}

export function peekTranscript(sessionId: string | null): TranscriptEntry | undefined {
  return sessionId ? entries.get(sessionId) : undefined;
}

export function forgetTranscript(sessionId: string): void {
  entries.delete(sessionId);
}
