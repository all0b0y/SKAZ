import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { Button } from '../ui/Button';
import { fadeAway, flatten, playWave } from './startupMotion';

/** How long a normal start stays silent before one quiet reassurance line appears. */
export const SLOW_START_MS = 8_000;
const WAVE_BARS = 27;

type Phase = 'starting' | 'ready' | 'error';

/**
 * The startup screen follows the real backend start; it is not a timed splash.
 * Only an audio track while the local service starts (VoiceOver still hears the
 * status), a quiet line for a slow start, and real actions when it fails. Once
 * ready it stops taking input at once and fades; the tree's own intro plays in
 * the empty transcript.
 */
export function StartupScreen() {
  const backend = useStore((s) => s.backend);
  const ready = useStore((s) => s.ready);
  const reduced = useReducedMotion();
  const phase: Phase = ready ? 'ready' : backend.phase === 'error' ? 'error' : 'starting';

  const [present, setPresent] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const leavingRef = useRef(false);
  const gateRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);

  // A backend that fails after being ready brings the screen back with its error.
  useEffect(() => {
    if (phase !== 'error' || present) return;
    leavingRef.current = false;
    setLeaving(false);
    setPresent(true);
  }, [phase, present]);

  useEffect(() => {
    if (!present || phase !== 'starting') return undefined;
    return playWave(waveRef.current, reduced);
  }, [present, phase, reduced]);

  useEffect(() => {
    if (phase !== 'starting') { setSlow(false); return undefined; }
    const timer = window.setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'error' || !present) return;
    setRetrying(false);
    flatten(waveRef.current);
  }, [phase, present]);

  useEffect(() => {
    if (phase !== 'ready' || leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    const gate = gateRef.current;
    if (!gate) { setPresent(false); return; }
    void fadeAway(gate, reduced).then(() => setPresent(false));
  }, [phase, reduced]);

  if (!present) return null;

  const bridge = window.skaz;
  const retry = () => {
    setRetrying(true);
    void bridge.restartBackend?.()
      .then((started) => { if (!started) setRetrying(false); })
      .catch(() => setRetrying(false));
  };

  return (
    <div ref={gateRef} className="gate startup" data-phase={phase} data-state={leaving ? 'leaving' : 'open'}
      aria-hidden={leaving || undefined}>
      <p className="visually-hidden" role="status">
        {phase === 'error' ? 'The backend didn’t start' : phase === 'ready' ? 'SKAZ is ready' : 'Starting SKAZ…'}
      </p>
      <div className="startup__stage">
        <div ref={waveRef} className="startup__wave" aria-hidden="true">
          {Array.from({ length: WAVE_BARS }, (_, index) => <span key={index} />)}
        </div>
        <div className="startup__below">
          {phase === 'starting' && slow && <p className="startup__slow">Still starting the local service…</p>}
          {phase === 'error' && (
            <div className="startup__error">
              <h2>The backend didn’t start</h2>
              <p>SKAZ couldn’t start its local transcription service. Try again, or open the logs to see what went wrong.</p>
              {backend.detail && <p className="startup__detail">{backend.detail}</p>}
              {backend.hint && <p className="startup__detail">{backend.hint}</p>}
              <div className="startup__actions">
                {bridge.restartBackend && (
                  <Button variant="primary" onClick={retry} disabled={retrying}>Try again</Button>
                )}
                {bridge.openLogsFolder && (
                  <Button variant="ghost" onClick={() => void bridge.openLogsFolder?.()}>Open logs</Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
