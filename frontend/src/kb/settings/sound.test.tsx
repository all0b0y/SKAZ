import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { CaptureEngine } from '../recording/capture';
import type { MediaAccess } from '../../api/bridge';

// The level meter's input is faked at the browser seam (getUserMedia + analyser): this proves the
// row opens the chosen input only while shown and closes it, not how a real microphone sounds.
const meter = vi.hoisted(() => ({
  open: vi.fn<(deviceId: string, onLevel: (level: number) => void) => Promise<() => void>>(),
  system: vi.fn<(onLevel: (level: number) => void) => Promise<() => void>>(),
  stop: vi.fn(),
  push: null as ((level: number) => void) | null,
}));
vi.mock('../recording/micLevel', () => ({
  browserMicLevel: { open: meter.open },
  browserSystemAudioLevel: { open: meter.system },
  levelFromRms: () => 0,
}));

const MICS = [
  { deviceId: 'mic-usb', kind: 'audioinput', label: 'USB Microphone', groupId: 'g1' },
  { deviceId: 'mic-built-in', kind: 'audioinput', label: 'MacBook Pro Microphone', groupId: 'g2' },
] as unknown as MediaDeviceInfo[];

function stubDevices() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => MICS),
      getUserMedia: vi.fn(async () => { throw new Error('Settings must not open the microphone itself'); }),
      getDisplayMedia: vi.fn(async () => { throw new Error('Settings must not open computer audio itself'); }),
    },
  });
}

const openSound = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
  return dialog;
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

function captureFake() {
  const e: CaptureEngine = {
    start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => true), elapsedMs: () => 0, pending: () => ({ pending: 0, failed: 0 }),
  };
  return e;
}

beforeEach(() => {
  stubDevices();
  meter.open.mockReset();
  meter.stop.mockReset();
  meter.open.mockImplementation(async (_id, onLevel) => { meter.push = onLevel; return meter.stop; });
});
afterEach(() => { Reflect.deleteProperty(navigator, 'mediaDevices'); });

describe('Settings → Microphone and Computer audio (B20)', () => {
  it('lists the inputs with a live level only while shown; the choice is the Record default; closing stops it', async () => {
    const user = userEvent.setup();
    const engine = captureFake();
    const { fake, services } = renderKb({ world: docWorld(), capture: () => engine });
    const dialog = await openSound();
    const mic = row(dialog, 'Microphone');
    const select = within(mic).getByRole('combobox', { name: 'Default microphone' });
    await within(mic).findByRole('option', { name: 'USB Microphone' });
    expect(select).toHaveValue('');
    await waitFor(() => expect(meter.open).toHaveBeenCalledWith('', expect.any(Function)));
    meter.push!(0.6);
    expect(await within(mic).findByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '60');

    await user.selectOptions(select, 'mic-usb');
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/settings', body: { input_device_id: 'mic-usb' } })));
    // The meter follows the chosen input: the old one is closed, the new one opened.
    await waitFor(() => expect(meter.open).toHaveBeenLastCalledWith('mic-usb', expect.any(Function)));
    expect(meter.stop).toHaveBeenCalledTimes(1);
    expect(services.recording.getState().options.deviceId).toBe('mic-usb');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument());
    expect(meter.stop).toHaveBeenCalledTimes(2);
    // Settings never started a recording.
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/recordings')).toBe(false);
    expect(engine.start).not.toHaveBeenCalled();

    // Record uses the default chosen in Settings.
    const record = await within(screen.getByTestId('titlebar')).findByRole('button', { name: 'Record' });
    await user.click(record);
    await waitFor(() => expect(engine.start).toHaveBeenCalled());
    expect((engine.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].sources).toEqual({ deviceId: 'mic-usb', systemAudio: false });
  });

  it('microphone access off: says so with the privacy pane, and never opens the input', async () => {
    const access: MediaAccess = { microphone: 'denied', screen: 'granted' };
    const openPane = vi.fn(async () => true);
    renderKb({ world: docWorld(), bridge: { mediaAccess: vi.fn(async () => access), openSystemAudioSettings: openPane } });
    const dialog = await openSound();
    const mic = row(dialog, 'Microphone');
    expect(await within(mic).findByText('Microphone access is off for SKAZ')).toBeInTheDocument();
    fireEvent.click(within(mic).getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => expect(openPane).toHaveBeenCalledWith('microphone'));
    expect(within(mic).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('a refused getUserMedia shows the same honest state', async () => {
    meter.open.mockImplementation(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
    renderKb({ world: docWorld(), bridge: { openSystemAudioSettings: vi.fn(async () => true) } });
    const dialog = await openSound();
    const mic = row(dialog, 'Microphone');
    expect(await within(mic).findByText('Microphone access is off for SKAZ')).toBeInTheDocument();
    expect(within(mic).getByRole('button', { name: 'Open System Settings' })).toBeInTheDocument();
  });

  it('Computer audio: the default switch; never calls it off from the Screen Recording status (QA live 16.10)', async () => {
    const user = userEvent.setup();
    const engine = captureFake();
    const { fake } = renderKb({
      world: docWorld(), capture: () => engine,
      // Screen Recording off is a different permission: system audio needs "System Audio Recording Only".
      bridge: { systemAudioSupported: true, mediaAccess: vi.fn(async () => ({ microphone: 'granted', screen: 'denied' } as MediaAccess)), openSystemAudioSettings: vi.fn(async () => true) },
    });
    const dialog = await openSound();
    const sys = row(dialog, 'Computer audio');
    expect(await within(sys).findByRole('button', { name: 'Check' })).toBeInTheDocument();
    expect(within(sys).queryByText(/is off for SKAZ/)).not.toBeInTheDocument();
    expect(meter.system).not.toHaveBeenCalled(); // nothing is opened until the user asks
    await user.click(within(sys).getByRole('switch', { name: 'Computer audio' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/settings', body: { capture_system_audio: true } })));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument());
    await user.click(await within(screen.getByTestId('titlebar')).findByRole('button', { name: 'Record' }));
    await waitFor(() => expect(engine.start).toHaveBeenCalled());
    expect((engine.start as ReturnType<typeof vi.fn>).mock.calls[0]![0].sources).toEqual({ systemAudio: true });
  });

  it('Computer audio Check: sound heard → it reaches SKAZ, and the capture is closed', async () => {
    const stop = vi.fn();
    meter.system.mockImplementation(async (onLevel) => { setTimeout(() => onLevel(0.4), 0); return stop; });
    renderKb({ world: docWorld(), bridge: { systemAudioSupported: true } });
    const dialog = await openSound();
    const sys = row(dialog, 'Computer audio');
    fireEvent.click(await within(sys).findByRole('button', { name: 'Check' }));
    expect(await within(sys).findByText('Computer audio reaches SKAZ')).toBeInTheDocument();
    expect(stop).toHaveBeenCalled();
  });

  it('Computer audio Check: macOS refuses → says so with the privacy pane', async () => {
    const openPane = vi.fn(async () => true);
    meter.system.mockImplementation(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
    renderKb({ world: docWorld(), bridge: { systemAudioSupported: true, openSystemAudioSettings: openPane } });
    const dialog = await openSound();
    const sys = row(dialog, 'Computer audio');
    fireEvent.click(await within(sys).findByRole('button', { name: 'Check' }));
    expect(await within(sys).findByText('macOS doesn’t let SKAZ record computer audio')).toBeInTheDocument();
    fireEvent.click(within(sys).getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => expect(openPane).toHaveBeenCalledWith('system-audio'));
  });

  it('Computer audio Check: only silence → says nothing was heard, closes the capture', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stop = vi.fn();
      meter.system.mockImplementation(async (onLevel) => { onLevel(0); return stop; });
      renderKb({ world: docWorld(), bridge: { systemAudioSupported: true, openSystemAudioSettings: vi.fn(async () => true) } });
      const dialog = await openSound();
      const sys = row(dialog, 'Computer audio');
      fireEvent.click(await within(sys).findByRole('button', { name: 'Check' }));
      expect(await within(sys).findByRole('meter', { name: 'Computer audio level' })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await within(sys).findByText(/Nothing was heard/)).toBeInTheDocument();
      expect(stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Computer audio where this Mac can’t capture it: said plainly, no switch', async () => {
    renderKb({ world: docWorld() });
    const dialog = await openSound();
    const sys = row(dialog, 'Computer audio');
    expect(within(sys).getByText('Not available on this Mac')).toBeInTheDocument();
    expect(within(sys).queryByRole('switch')).not.toBeInTheDocument();
  });
});
