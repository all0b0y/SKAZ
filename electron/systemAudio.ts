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

/** Privacy pane holding "Screen & System Audio Recording" (macOS only). */
export const SYSTEM_AUDIO_SETTINGS_URL: string | null = process.platform === 'darwin'
  ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  : null;
