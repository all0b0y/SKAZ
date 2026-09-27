/**
 * Not a behaviour test: dumps the real RecorderBar markup for each capsule state
 * so scripts/recorder-capsule.smoke.spec.ts can lay it out with the built CSS in
 * Electron/Chromium. Runs only when SKAZ_CAPSULE_DUMP is set.
 */
import { it } from 'vitest';
import { act, render } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { RecorderBar } from './RecorderBar';
import { useStore } from '../../state/store';
import { idleMeterSnapshot } from '../../audio/meter';

const out = process.env.SKAZ_CAPSULE_DUMP;

it.runIf(Boolean(out))('dumps capsule states', () => {
  const base = {
    elapsedMs: 192_000, meter: idleMeterSnapshot(), finishing: false, recorderError: null,
    queue: { pending: 0, inFlight: null, completed: 0, duplicates: 0, failed: [], droppedCount: 0, overflow: false, lastError: null },
    transcription: { pending: 0, inFlight: null, completed: 0, failed: [], deferred: 0, diskFailed: 0, blockedByConsent: false, lastError: null },
    detail: null, sessions: [], activeSessionId: null, pendingSessionStatus: null, nextRecordingMode: 'legacy', liveCapabilities: null,
    systemAudioIssue: null, settings: null,
  };
  const withSystemAudio = { settings: { capture_system_audio: true, provider_has_api_key: { soniox: true }, cloud_consent: true } };
  const states: Record<string, object> = {
    idle: { recorderState: 'idle', elapsedMs: 0 },
    imported: { recorderState: 'stopped', activeSessionId: 'import', sessions: [{ id: 'import', title: 'Imported', created_at: '', status: 'stopped', duration_ms: 1000, mode: 'legacy', origin: 'import' }] },
    recording: { recorderState: 'recording' },
    paused: { recorderState: 'paused' },
    finishing: { recorderState: 'processing', finishing: true },
    error: { recorderState: 'stopped', recorderError: 'Backend stop confirmation failed: network unreachable', pendingSessionStatus: 'stopped', pendingSessionStatusSessionId: 's' },
    'system-on': { recorderState: 'idle', elapsedMs: 0, ...withSystemAudio },
    'system-recording': { recorderState: 'recording', ...withSystemAudio },
    'system-denied': { recorderState: 'idle', elapsedMs: 0, ...withSystemAudio,
      recorderError: 'System audio is not allowed. Grant SKAZ “System Audio Recording” in System Settings, or record the microphone only.',
      systemAudioIssue: { phase: 'start', reason: 'denied' } },
  };
  window.skaz = { ...window.skaz, systemAudioSupported: true, openSystemAudioSettings: async () => true };
  const dump: Record<string, string> = {};
  for (const [name, state] of Object.entries(states)) {
    useStore.setState({ ...base, ...state } as never);
    const view = render(<RecorderBar />);
    if (name === 'recording' || name === 'system-recording') {
      for (let i = 0; i < 34; i += 1) {
        act(() => useStore.setState({ meter: { dbfs: -48 + 34 * Math.abs(Math.sin(i / 3)), peakDbfs: -6, clipping: false } } as never));
      }
    }
    dump[name] = view.container.innerHTML;
    view.unmount();
  }
  fs.mkdirSync(path.dirname(out!), { recursive: true });
  fs.writeFileSync(out!, JSON.stringify(dump));
});
