import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../api/bridge';
import type { Settings } from '../api/types';
import { useStore } from './store';
import { captureSourcesLocked } from './captureSources';

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' }, agent: { provider: 'openrouter', model: 'a' },
  notes: { provider: 'openrouter', model: 'n' }, transcript_language: 'auto', output_language: 'en',
  cloud_consent: true, contextual_local_enabled: false, input_device_id: null, capture_system_audio: false, ...over,
});

const bridge = window.skaz as unknown as Omit<BridgeApi, 'request'> & { request: ReturnType<typeof vi.fn> };
let stored: Settings;
let failNext = false;

beforeEach(() => {
  stored = settings();
  failNext = false;
  bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (req.path === '/settings' && req.method === 'GET') return { ok: true, status: 200, data: stored };
    if (req.path === '/settings' && req.method === 'PUT') {
      if (failNext) { failNext = false; return { ok: false, status: 500, detail: 'disk full' }; }
      const body = req.body as { input_device_id?: string; capture_system_audio?: boolean };
      stored = { ...stored,
        ...(body.input_device_id !== undefined ? { input_device_id: body.input_device_id || null } : {}),
        ...(body.capture_system_audio !== undefined ? { capture_system_audio: body.capture_system_audio } : {}) };
      return { ok: true, status: 200, data: stored };
    }
    if (req.path === '/asr/live/capabilities') return { ok: true, status: 200, data: { capable: false } };
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  useStore.setState({ settings: settings(), selectedDeviceId: null, recorderState: 'idle', settingsError: null });
});

it('persists the microphone choice in settings and mirrors it as the selected device', async () => {
  await useStore.getState().selectDevice('usb-mic');
  expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT', path: '/settings', body: { input_device_id: 'usb-mic' } }));
  expect(useStore.getState().selectedDeviceId).toBe('usb-mic');
  expect(useStore.getState().settings?.input_device_id).toBe('usb-mic');
});

it('reads the saved microphone back after a restart', async () => {
  stored = settings({ input_device_id: 'saved-mic', capture_system_audio: true });
  await useStore.getState().refreshSettings();
  expect(useStore.getState().selectedDeviceId).toBe('saved-mic');
});

it('keeps a saved microphone that is not connected instead of overwriting it', async () => {
  stored = settings({ input_device_id: 'airpods' });
  await useStore.getState().refreshSettings();
  useStore.setState({ devices: [{ deviceId: 'built-in', label: 'Built-in', kind: 'audioinput' } as MediaDeviceInfo] });
  expect(useStore.getState().selectedDeviceId).toBe('airpods');
  expect(stored.input_device_id).toBe('airpods');
});

it('persists the system-audio toggle', async () => {
  await useStore.getState().setCaptureSystemAudio(true);
  expect(useStore.getState().settings?.capture_system_audio).toBe(true);
  expect(stored.capture_system_audio).toBe(true);
});

it('rolls back and reports when saving fails', async () => {
  failNext = true;
  await expect(useStore.getState().selectDevice('usb-mic')).rejects.toThrow('disk full');
  expect(useStore.getState().selectedDeviceId).toBeNull();
  expect(useStore.getState().settings?.input_device_id).toBeNull();
});

it('locks capture sources only while actually recording, not while paused', async () => {
  expect(captureSourcesLocked('recording')).toBe(true);
  expect(captureSourcesLocked('processing')).toBe(true);
  expect(captureSourcesLocked('paused')).toBe(false);
  expect(captureSourcesLocked('idle')).toBe(false);
  useStore.setState({ recorderState: 'recording' });
  await useStore.getState().selectDevice('usb-mic');
  await useStore.getState().setCaptureSystemAudio(true);
  expect(bridge.request).not.toHaveBeenCalled();
  useStore.setState({ recorderState: 'paused' });
  await useStore.getState().selectDevice('usb-mic');
  expect(useStore.getState().selectedDeviceId).toBe('usb-mic');
});
