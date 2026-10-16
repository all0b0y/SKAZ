import { useEffect } from 'react';
import { hasBackgroundTranscription, useNativeProcessing } from './nativeProcessing';

/** Poll small status documents, including work on sessions the user left. */
export function useBackgroundTranscription(sessionId: string | null, capturing: boolean) {
  const processingKey = useNativeProcessing(s => Object.keys(s.sessions)
    .filter(id => s.sessions[id]?.processing).sort().join('|'));
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const store = useNativeProcessing.getState();
      const ids = new Set(Object.keys(store.sessions).filter(id => store.sessions[id]?.processing));
      if (sessionId && !capturing) ids.add(sessionId);
      let failed = false;
      for (const id of ids) {
        if (!alive) return;
        try { await store.refresh(id); } catch { failed = true; }
      }
      if (alive && (failed || hasBackgroundTranscription())) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [sessionId, capturing, processingKey]);
  return useNativeProcessing(s => sessionId ? s.sessions[sessionId] : undefined);
}
