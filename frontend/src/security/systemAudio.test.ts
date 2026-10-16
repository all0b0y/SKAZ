import { describe, expect, it } from 'vitest';
import { mediaAccessOf, privacySettingsUrl, systemAudioSupported } from '../../../electron/systemAudio';

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

describe('Open System Settings for a capture permission', () => {
  it('opens only the fixed macOS privacy panes the renderer names', () => {
    expect(privacySettingsUrl('darwin', 'microphone')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    expect(privacySettingsUrl('darwin', 'system-audio')).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });

  it('refuses anything else: other panes, URLs, prototype keys, other systems', () => {
    for (const pane of ['camera', 'https://example.com', 'x-apple.systempreferences:x', '__proto__', 'toString', undefined, null, 1]) {
      expect(privacySettingsUrl('darwin', pane), String(pane)).toBeNull();
    }
    expect(privacySettingsUrl('win32', 'microphone')).toBeNull();
    expect(privacySettingsUrl('linux', 'system-audio')).toBeNull();
  });
});

describe('macOS privacy state for Settings → Sound (B20)', () => {
  it('passes the known statuses through and reads each kind', () => {
    const read = (kind: 'microphone' | 'screen') => (kind === 'microphone' ? 'granted' : 'denied');
    expect(mediaAccessOf('darwin', read)).toEqual({ microphone: 'granted', screen: 'denied' });
    expect(mediaAccessOf('darwin', () => 'not-determined')).toEqual({ microphone: 'not-determined', screen: 'not-determined' });
  });

  it('anything unexpected, a failing read or another system is unknown', () => {
    expect(mediaAccessOf('darwin', () => 'weird')).toEqual({ microphone: 'unknown', screen: 'unknown' });
    expect(mediaAccessOf('darwin', () => { throw new Error('no'); })).toEqual({ microphone: 'unknown', screen: 'unknown' });
    expect(mediaAccessOf('linux', () => 'granted')).toEqual({ microphone: 'unknown', screen: 'unknown' });
  });
});
