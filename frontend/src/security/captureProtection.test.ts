import { describe, expect, it } from 'vitest';
import { hasUnsentAudio, type CaptureProtectionState } from '../../../electron/captureProtection';

const state = (over: Partial<CaptureProtectionState> = {}): CaptureProtectionState => ({
  recorderState: 'idle',
  pending: 0,
  failed: 0,
  ...over,
});

describe('window close audio protection', () => {
  it('guards active capture, draining uploads, and recoverable failed audio', () => {
    expect(hasUnsentAudio(state({ recorderState: 'recording' }))).toBe(true);
    expect(hasUnsentAudio(state({ recorderState: 'processing' }))).toBe(true);
    expect(hasUnsentAudio(state({ pending: 1 }))).toBe(true);
    expect(hasUnsentAudio(state({ failed: 1 }))).toBe(true);
    expect(hasUnsentAudio(state())).toBe(false);
  });
});
