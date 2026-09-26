import { useEffect, useState } from 'react';
import { ApiClient, ApiError } from '../../api/client';
import type { NativeSnapshot } from '../../api/nativeLive';
import type { Segment } from '../../api/types';

/** Compatibility only for servers/archives without the event-page endpoint. */
export function useLegacyNativeTranscript(sessionId: string | null, polling: boolean, once = false) {
  const [version, setVersion] = useState(0);
  const [read, setRead] = useState<{ sessionId: string | null; snapshot: NativeSnapshot | null;
    segments: Segment[] | null; error: string | null }>({ sessionId: null, snapshot: null, segments: null, error: null });
  useEffect(() => {
    if (!sessionId) return;
    const api = new ApiClient(window.audiohelper);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      let again = polling && !once;
      try {
        let detail = await api.getSession(sessionId);
        if (cancelled) return;
        const snapshot = await api.getNativeSnapshot(sessionId);
        if (snapshot.session_id !== sessionId || !Number.isFinite(snapshot.sample_rate) || snapshot.sample_rate <= 0) {
          throw new Error('Invalid native transcript snapshot.');
        }
        if (cancelled) return;
        if (snapshot.transcription === 'inactive') detail = await api.getSession(sessionId);
        again ||= !once && snapshot.transcription !== 'inactive';
        if (!cancelled) setRead({ sessionId, snapshot, segments: detail.segments, error: null });
      } catch (error) {
        if (!cancelled) setRead(previous => ({ ...(previous.sessionId === sessionId ? previous : { sessionId, snapshot: null, segments: null, error: null }),
          error: error instanceof ApiError && error.status === 404 && (!previous.snapshot || previous.sessionId !== sessionId)
            ? null : 'Could not refresh Soniox transcript. Displayed data may be out of date.',
        }));
      } finally {
        if (!cancelled && again) timer = setTimeout(() => { void refresh(); }, 1000);
      }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, polling, version, once]);
  return { ...(read.sessionId === sessionId ? read : { snapshot: null, segments: null, error: null }),
    retry: () => setVersion(v => v + 1) };
}
