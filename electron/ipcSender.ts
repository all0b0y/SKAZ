// Sender + payload validation for IPC received in the main process. Pure (no
// Electron imports) so the trust rules are unit-tested. Every ipcMain handler
// must verify the message came from the main window's main frame and that any
// renderer-supplied payload is shape- and bound-checked before use.
import type { CaptureProtectionState } from './captureProtection';

export interface FrameContext {
  senderId: number;
  expectedId: number | null;
  isMainFrame: boolean;
}

/** True only for the main frame of the currently registered main window. */
export function isTrustedFrame(ctx: FrameContext): boolean {
  return ctx.expectedId !== null && ctx.senderId === ctx.expectedId && ctx.isMainFrame === true;
}

const RECORDER_STATES: readonly CaptureProtectionState['recorderState'][] = [
  'idle',
  'recording',
  'paused',
  'processing',
  'stopped',
];
// Generous upper bound: a real backlog is tens, not tens of thousands. Anything
// larger is a bug or a hostile payload.
const MAX_COUNT = 1_000_000;

function isBoundedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isRecorderState(value: unknown): value is CaptureProtectionState['recorderState'] {
  return typeof value === 'string' && (RECORDER_STATES as readonly string[]).includes(value);
}

/**
 * Validate and normalize a renderer-reported capture snapshot. Returns a clean
 * object with only the known fields, or null when the payload is untrustworthy.
 */
export function validateCaptureState(payload: unknown): CaptureProtectionState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as { recorderState?: unknown; pending?: unknown; failed?: unknown };
  if (!isRecorderState(raw.recorderState)) return null;
  if (!isBoundedCount(raw.pending) || !isBoundedCount(raw.failed)) return null;
  return { recorderState: raw.recorderState, pending: raw.pending, failed: raw.failed };
}
