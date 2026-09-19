import { describe, expect, it, vi } from 'vitest';
import { listInputDevices } from './devices';

/**
 * macOS/Chromium hides device labels until the page holds a microphone grant.
 * Enumerating cold therefore returns real deviceIds with empty labels, which the
 * UI rendered as "Microphone 1" — a placeholder the user cannot map to hardware.
 */

const device = (deviceId: string, label: string, kind = 'audioinput'): MediaDeviceInfo =>
  ({ deviceId, label, kind, groupId: 'g' }) as MediaDeviceInfo;

const grantedStream = (stop = vi.fn()) =>
  ({ getTracks: () => [{ stop }] }) as unknown as MediaStream;

describe('listInputDevices', () => {
  it('returns labelled devices without asking for permission again', async () => {
    const requestPermission = vi.fn();
    const enumerate = vi.fn(async () => [device('mic-1', 'MacBook Pro Microphone')]);

    const devices = await listInputDevices({ enumerate, requestPermission });

    expect(devices.map((d) => d.label)).toEqual(['MacBook Pro Microphone']);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks for permission and re-enumerates when labels are hidden', async () => {
    const requestPermission = vi.fn(async () => grantedStream());
    const enumerate = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce([device('mic-1', '')])
      .mockResolvedValueOnce([device('mic-1', 'MacBook Pro Microphone')]);

    const devices = await listInputDevices({ enumerate, requestPermission });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(devices.map((d) => d.label)).toEqual(['MacBook Pro Microphone']);
  });

  it('releases the probe stream so the mic indicator does not stay lit', async () => {
    const stop = vi.fn();
    const enumerate = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce([device('mic-1', '')])
      .mockResolvedValueOnce([device('mic-1', 'Real Name')]);

    await listInputDevices({ enumerate, requestPermission: async () => grantedStream(stop) });

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the unlabelled devices when permission is refused', async () => {
    const enumerate = vi.fn(async () => [device('mic-1', '')]);
    const requestPermission = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });

    const devices = await listInputDevices({ enumerate, requestPermission });

    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceId).toBe('mic-1');
  });

  it('never probes when there is no input hardware at all', async () => {
    const requestPermission = vi.fn();

    const devices = await listInputDevices({
      enumerate: async () => [device('speaker', 'Speakers', 'audiooutput')],
      requestPermission,
    });

    expect(devices).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('drops the synthetic "default" duplicate macOS reports', async () => {
    const devices = await listInputDevices({
      enumerate: async () => [
        device('default', 'Default - MacBook Pro Microphone'),
        device('abc123', 'MacBook Pro Microphone'),
      ],
      requestPermission: vi.fn(),
    });

    expect(devices.map((d) => d.deviceId)).toEqual(['abc123']);
  });

  it('keeps the default entry when it is the only input', async () => {
    const devices = await listInputDevices({
      enumerate: async () => [device('default', 'Default - MacBook Pro Microphone')],
      requestPermission: vi.fn(),
    });

    expect(devices.map((d) => d.deviceId)).toEqual(['default']);
  });
});
