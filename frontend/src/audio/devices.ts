// Input-device discovery.
//
// macOS (via Chromium) hides device labels until the page holds a microphone
// grant: a cold `enumerateDevices()` returns real deviceIds with empty `label`
// strings, which the UI could only render as "Microphone 1" — a placeholder the
// user cannot map to actual hardware. The fix is to notice the hidden labels,
// ask for the grant once, and re-enumerate.

export interface DeviceDiscovery {
  enumerate: () => Promise<MediaDeviceInfo[]>;
  /** Requests the microphone grant. The returned stream is released immediately. */
  requestPermission: () => Promise<MediaStream>;
}

const INPUT_KIND = 'audioinput';

function inputs(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter((d) => d.kind === INPUT_KIND);
}

/**
 * macOS reports a synthetic "default" entry that mirrors a real device, so the
 * same microphone appears twice under two names. Keep the concrete device —
 * unless "default" is all there is, in which case it is the only way to record.
 */
function withoutDuplicateDefault(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const concrete = devices.filter((d) => d.deviceId !== 'default');
  return concrete.length > 0 ? concrete : devices;
}

export async function listInputDevices(discovery: DeviceDiscovery): Promise<MediaDeviceInfo[]> {
  const found = inputs(await discovery.enumerate());
  // No input hardware: a permission prompt would be pure noise.
  if (found.length === 0) return [];
  if (found.every((d) => d.label !== '')) return withoutDuplicateDefault(found);

  try {
    const stream = await discovery.requestPermission();
    // Release at once: holding the track keeps the system mic indicator lit and
    // can block the real recorder from opening the device.
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Denied or unavailable. Unlabelled devices still let the user record with
    // the system default, so return what we have rather than an empty list.
    return withoutDuplicateDefault(found);
  }

  return withoutDuplicateDefault(inputs(await discovery.enumerate()));
}

/** Discovery bound to the real browser APIs. */
export const browserDiscovery: DeviceDiscovery = {
  enumerate: () => navigator.mediaDevices.enumerateDevices(),
  requestPermission: () => navigator.mediaDevices.getUserMedia({ audio: true }),
};
