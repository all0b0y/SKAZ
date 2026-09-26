import { describe, expect, it } from 'vitest';
import { systemAudioSupported } from '../../../electron/systemAudio';

describe('system audio support', () => {
  it('needs macOS 14.2 or later', () => {
    expect(systemAudioSupported('darwin', '26.6.2')).toBe(true);
    expect(systemAudioSupported('darwin', '15.0')).toBe(true);
    expect(systemAudioSupported('darwin', '14.2')).toBe(true);
    expect(systemAudioSupported('darwin', '14.1.1')).toBe(false);
    expect(systemAudioSupported('darwin', '13.6')).toBe(false);
    expect(systemAudioSupported('darwin', '')).toBe(false);
  });

  it('is offered on Windows and not on Linux', () => {
    expect(systemAudioSupported('win32', '10.0.22631')).toBe(true);
    expect(systemAudioSupported('linux', '6.8')).toBe(false);
  });
});
