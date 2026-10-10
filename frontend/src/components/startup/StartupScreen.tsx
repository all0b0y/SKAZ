import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { SAP } from '../../brand/treeGeometry';
import { TreeMark } from '../brand/TreeMark';
import { Button } from '../ui/Button';
import { fail, handOff, runStartup, settle } from './startupMotion';

/** How long a normal start stays silent before one quiet reassurance line appears. */
export const SLOW_START_MS = 8_000;
const WAVE_BARS = 23;

type Phase = 'starting' | 'ready' | 'error';

/**
 * The startup screen follows the real backend start; it is not a timed splash.
 * No visible text in a normal start (VoiceOver still hears the status), a quiet
 * line for a slow one, and real actions when it fails. Once the backend is
 * ready it stops taking input at once and hands its tree to the workspace.
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
  const treeRef = useRef<SVGSVGElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);

  // A backend that fails after being ready brings the screen back with its error.
  useEffect(() => {
    if (phase !== 'error' || present) return;
    leavingRef.current = false;
    setLeaving(false);
    setPresent(true);
  }, [phase, present]);

  useEffect(() => {
    const svg = treeRef.current;
    if (!present || phase !== 'starting' || !svg) return undefined;
    return runStartup(svg, waveRef.current, reduced);
  }, [present, phase, reduced]);

  useEffect(() => {
    if (phase !== 'starting') { setSlow(false); return undefined; }
    const timer = window.setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'error' || !present) return;
    setRetrying(false);
    if (treeRef.current) fail(treeRef.current, waveRef.current, reduced);
  }, [phase, present, reduced]);

  useEffect(() => {
    if (phase !== 'ready' || leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    const gate = gateRef.current;
    const svg = treeRef.current;
    if (!gate || !svg) { setPresent(false); return; }
    settle(svg, waveRef.current);
    void handOff(gate, svg, reduced).then(() => setPresent(false));
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
      <div className="startup__backdrop" />
      <p className="visually-hidden" role="status">
        {phase === 'error' ? 'The backend didn’t start' : phase === 'ready' ? 'SKAZ is ready' : 'Starting SKAZ…'}
      </p>
      <div className="startup__stage">
        <TreeMark ref={treeRef} className="startup__tree" aria-hidden="true">
          <g className="startup__sap">
            {SAP.trunk.map((cell, index) => (
              <rect key={`trunk-${index}`} data-part="trunk" x={cell.x - cell.size / 2} y={cell.y - cell.size / 2}
                width={cell.size} height={cell.size} rx={2} />
            ))}
            {SAP.branches.map((cell, index) => (
              <rect key={`branch-${index}`} data-part="branch" x={cell.x - cell.size / 2} y={cell.y - cell.size / 2}
                width={cell.size} height={cell.size} rx={2} />
            ))}
          </g>
          <g className="startup__sparks" />
        </TreeMark>
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
