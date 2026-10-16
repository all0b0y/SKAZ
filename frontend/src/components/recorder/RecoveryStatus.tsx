import { useEffect, useState } from 'react';

interface Recovery { state: string; attempt: number; max_attempts: number }

/** Small status reads, independent of transcript availability or speech/silence. */
export function RecoveryStatus({ sessionId, active }: { sessionId?: string; active: boolean }) {
  const [status, setStatus] = useState<Recovery | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!active || !sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const reply = await window.skaz.request<Recovery>({
          method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}/live/status`,
        });
        if (alive) setStatus(reply.ok ? reply.data : null);
      } catch { if (alive) setStatus(null); }
      finally { if (alive) timer = setTimeout(() => { void poll(); }, 500); }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [active, sessionId]);
  if (!active || !status || !['connecting', 'reconnecting'].includes(status.state)) return null;
  return <span className="capsule__label" role="status">
    Reconnecting to Soniox… Attempt {status.attempt || 1}/{status.max_attempts}
  </span>;
}
