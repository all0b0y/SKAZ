// System-audio capability, kept pure so preload and tests share it.
//
// macOS exposes whole-system loopback audio to Chromium through Core Audio taps
// from 14.2; Windows has WASAPI loopback. Linux support depends on the audio
// server, so it is not offered (.dev/docs/CAPTURE-SOURCES-BULK-SPEC.md §1).

export function systemAudioSupported(platform: string, systemVersion: string): boolean {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  const [major = 0, minor = 0] = systemVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2);
}

/** The System Settings panes SKAZ may open for a capture permission; the renderer only names one. */
export type PrivacyPane = 'microphone' | 'system-audio';

const MAC_PRIVACY_PANES: Record<PrivacyPane, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  // "Screen & System Audio Recording" holds whole-system audio capture.
  'system-audio': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

/** Fixed destination for a named pane (macOS only); anything else gets null, never a renderer URL. */
export function privacySettingsUrl(platform: string, pane: unknown): string | null {
  if (platform !== 'darwin' || typeof pane !== 'string' || !Object.hasOwn(MAC_PRIVACY_PANES, pane)) return null;
  return MAC_PRIVACY_PANES[pane as PrivacyPane];
}

export type MediaAccessStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
const STATUSES: ReadonlySet<string> = new Set(['granted', 'denied', 'restricted', 'not-determined']);

/**
 * SKAZ's macOS privacy state for the microphone and for screen & system audio recording, read only
 * (asking nothing). Anything but a known status, any error and any other system is 'unknown'.
 */
export function mediaAccessOf(
  platform: string,
  read: (kind: 'microphone' | 'screen') => string,
): { microphone: MediaAccessStatus; screen: MediaAccessStatus } {
  const one = (kind: 'microphone' | 'screen'): MediaAccessStatus => {
    if (platform !== 'darwin') return 'unknown';
    try {
      const value = read(kind);
      return STATUSES.has(value) ? (value as MediaAccessStatus) : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return { microphone: one('microphone'), screen: one('screen') };
}
