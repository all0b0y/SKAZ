import { describe, it, expect } from 'vitest';
import { isTrustedFrame, validateCaptureState } from '../../../electron/ipcSender';

describe('isTrustedFrame', () => {
  it('accepts only the main frame of the expected webContents', () => {
    expect(isTrustedFrame({ senderId: 7, expectedId: 7, isMainFrame: true })).toBe(true);
  });

  it('rejects a mismatched webContents id', () => {
    expect(isTrustedFrame({ senderId: 9, expectedId: 7, isMainFrame: true })).toBe(false);
  });

  it('rejects when no window is registered yet', () => {
    expect(isTrustedFrame({ senderId: 7, expectedId: null, isMainFrame: true })).toBe(false);
  });

  it('rejects subframes even from the right webContents', () => {
    expect(isTrustedFrame({ senderId: 7, expectedId: 7, isMainFrame: false })).toBe(false);
  });
});

describe('validateCaptureState', () => {
  it('accepts a well-formed, bounded snapshot and normalizes it', () => {
    expect(validateCaptureState({ recorderState: 'recording', pending: 3, failed: 0 })).toEqual({
      recorderState: 'recording',
      pending: 3,
      failed: 0,
    });
  });

  it('ignores unknown extra fields but keeps the known ones', () => {
    expect(
      validateCaptureState({ recorderState: 'idle', pending: 0, failed: 0, evil: '__proto__' }),
    ).toEqual({ recorderState: 'idle', pending: 0, failed: 0 });
  });

  it('rejects an unknown recorder state', () => {
    expect(validateCaptureState({ recorderState: 'hacking', pending: 0, failed: 0 })).toBeNull();
  });

  it('rejects non-object, missing, or malformed payloads', () => {
    expect(validateCaptureState(null)).toBeNull();
    expect(validateCaptureState('recording')).toBeNull();
    expect(validateCaptureState({ recorderState: 'idle', pending: 0 })).toBeNull();
  });

  it('rejects negative, fractional, or out-of-bound counts', () => {
    expect(validateCaptureState({ recorderState: 'idle', pending: -1, failed: 0 })).toBeNull();
    expect(validateCaptureState({ recorderState: 'idle', pending: 1.5, failed: 0 })).toBeNull();
    expect(validateCaptureState({ recorderState: 'idle', pending: 0, failed: 10_000_000 })).toBeNull();
    expect(validateCaptureState({ recorderState: 'idle', pending: Number.NaN, failed: 0 })).toBeNull();
  });
});
