import { useEffect, useState } from 'react';
import { ApiClient, ApiError } from '../../api/client';
import type { NativeSnapshot } from '../../api/nativeLive';
import type { Segment } from '../../api/types';

interface NativeRead {
  sessionId: string | null;
  snapshot: NativeSnapshot | null;
  segments: Segment[] | null;
  error: string | null;
}
const empty = (sessionId: string | null): NativeRead => ({ sessionId, snapshot: null, segments: null, error: null });

/** Read-only polling: at most one request chain; no ASR work or source mutation. */
export function useNativeTranscript(sessionId: string | null, polling: boolean): NativeRead & { retry: () => void } {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [read, setRead] = useState<NativeRead>(() => empty(sessionId));
  useEffect(() => {
    if (!sessionId) { setRead(empty(null)); return; }
    const api = new ApiClient(window.audiohelper);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRead((previous) => previous.sessionId === sessionId ? previous : empty(sessionId));
    const refresh = async () => {
      let continuePolling = polling;
      try {
        // Read final text before draft metadata: a newer final must not appear
        // beside an older draft containing the same words. Any unseen final
        // arrives on the next poll; draft is never promoted to fill that delay.
        let detail = await api.getSession(sessionId);
        if (cancelled) return;
        const snapshot = await api.getNativeSnapshot(sessionId);
        if (snapshot.session_id !== sessionId || !Number.isFinite(snapshot.sample_rate) || snapshot.sample_rate <= 0) {
          throw new Error('Invalid native transcript snapshot.');
        }
        // Inactive is terminal: refresh once after that barrier so the final
        // arriving between the two reads cannot be missed forever after Stop.
        if (cancelled) return;
        if (snapshot.transcription === 'inactive') detail = await api.getSession(sessionId);
        continuePolling ||= snapshot.transcription !== 'inactive';
        if (!cancelled) setRead({ sessionId, snapshot, segments: detail.segments, error: null });
      } catch (error) {
        if (!cancelled) setRead((previous) => ({
          ...(previous.sessionId === sessionId ? previous : empty(sessionId)),
          // An archive without a native recording legitimately has no snapshot.
          error: error instanceof ApiError && error.status === 404 && !previous.snapshot
            ? null : 'Could not refresh Soniox transcript. Displayed data may be out of date.',
        }));
      } finally {
        if (!cancelled && continuePolling) timer = setTimeout(() => { void refresh(); }, 1000);
      }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, polling, refreshVersion]);
  // Do not expose the previous session even for the render before effect cleanup.
  return { ...(read.sessionId === sessionId ? read : empty(sessionId)), retry: () => setRefreshVersion((v) => v + 1) };
}
