import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { ImportCapabilities } from '../../api/types';

let Dialog: typeof import('./ImportDialog')['ImportDialog'];
let requests: BridgeRequest[];
let caps: ImportCapabilities;
let created: ReturnType<typeof vi.fn>;
let duration: number | null;

const FILE = { path: '/Users/me/Downloads/lecture.m4a', name: 'lecture.m4a', url: 'file:///Users/me/Downloads/lecture.m4a' };

function defaults(): ImportCapabilities {
  return {
    supported_extensions: ['m4a', 'mp3', 'wav'],
    max_duration_ms: 300 * 60 * 1000,
    rate_per_hour_usd: 0.1,
    translation_rate_per_hour_usd: 0.15,
    warn_above_usd: 0.3,
    cloud_consent: true,
    has_api_key: true,
    active_imports: 0,
    max_concurrent_imports: 3,
    destination: 'App internal storage (export to a folder is off)',
    markdown_enabled: false,
  };
}

beforeEach(async () => {
  vi.resetModules();
  requests = [];
  caps = defaults();
  created = vi.fn();
  duration = 3_600_000; // one hour

  // The dialog reads the duration from container metadata, never by decoding.
  class FakeAudio {
    preload = '';
    duration = 0;
    private listeners: Record<string, (() => void)[]> = {};
    set src(_value: string) {
      queueMicrotask(() => {
        if (duration === null) {
          (this.listeners.error ?? []).forEach((fn) => fn());
          return;
        }
        this.duration = duration / 1000;
        (this.listeners.loadedmetadata ?? []).forEach((fn) => fn());
      });
    }
    addEventListener(name: string, fn: () => void) {
      (this.listeners[name] ??= []).push(fn);
    }
    removeAttribute() {}
  }
  vi.stubGlobal('Audio', FakeAudio);

  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      requests.push(req);
      if (req.method === 'GET' && req.path === '/imports') {
        return { ok: true, status: 200, data: caps as T };
      }
      return {
        ok: true, status: 201,
        data: { session: { id: 's1', title: 'Лекция', created_at: '', status: 'stopped', duration_ms: 0 },
          import_state: { session_id: 's1', status: 'queued' } } as T,
      };
    },
  };
  Dialog = (await import('./ImportDialog')).ImportDialog;
});

it('prefills the title from the file name and sends the read duration', async () => {
  const user = userEvent.setup();
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByDisplayValue('lecture')).toBeVisible();
  expect(await screen.findByText('1 h 00 min')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Transcribe' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
  expect(requests.filter((r) => r.method === 'POST')).toEqual([{
    method: 'POST', path: '/imports',
    body: { path: FILE.path, title: 'lecture', translate: false, declared_duration_ms: 3_600_000 },
  }]);
});

it('prices transcription and translation from the advertised rates', async () => {
  const user = userEvent.setup();
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText('≈ $0.10')).toBeVisible();
  await user.click(screen.getByRole('radio', { name: 'Transcription and translation' }));
  expect(await screen.findByText('≈ $0.15')).toBeVisible();
});

it('says the estimate is an estimate and where the result lands', async () => {
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText(/An estimate, not a bill/)).toBeVisible();
  expect(screen.getByText(/export to a folder is off/)).toBeVisible();
});

it('falls back to the rate alone when the duration cannot be read', async () => {
  duration = null;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText('could not be read from the file')).toBeVisible();
  expect(screen.getByText(/the exact amount is shown after processing/)).toBeVisible();
});

it('requires a second click above the cost threshold and sends nothing on the first', async () => {
  const user = userEvent.setup();
  duration = 4 * 3_600_000; // four hours ≈ $0.40, over the $0.30 threshold
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  await screen.findByText('4 h 00 min');
  // The price warning is visible before any click; the button still reads normally.
  expect(await screen.findByRole('alert')).toHaveTextContent(/more than your threshold of \$0\.30/);
  await user.click(screen.getByRole('button', { name: 'Transcribe' }));

  expect(requests.some((r) => r.method === 'POST')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Transcribe anyway' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
});

it('re-arms the confirmation when the price changes under the user', async () => {
  const user = userEvent.setup();
  duration = 4 * 3_600_000;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  await screen.findByText('4 h 00 min');
  await user.click(screen.getByRole('button', { name: 'Transcribe' }));
  await screen.findByRole('button', { name: 'Transcribe anyway' });

  // Switching to translation makes it more expensive: the confirmation must reset.
  await user.click(screen.getByRole('radio', { name: 'Transcription and translation' }));
  expect(await screen.findByRole('button', { name: 'Transcribe' })).toBeVisible();
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
});

it('explains missing cloud consent instead of silently disabling itself', async () => {
  caps = { ...defaults(), cloud_consent: false };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/sends the audio file to Soniox/);
  expect(screen.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
});

it('explains a missing API key', async () => {
  caps = { ...defaults(), has_api_key: false };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/Soniox key/);
});

it('refuses a file longer than the provider limit', async () => {
  duration = 301 * 60 * 1000;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  const alerts = await screen.findAllByRole('alert');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(/the provider does not accept it/);
  expect(screen.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
});

it('refuses another import instead of creating a queue', async () => {
  caps = { ...defaults(), active_imports: 3 };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText(/Another import is active/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Transcribe' })).toBeDisabled();
});

it('shows the real Markdown destination when the projection is on', async () => {
  caps = { ...defaults(), markdown_enabled: true, destination: '/Users/me/Documents/SKAZ' };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText('/Users/me/Documents/SKAZ')).toBeVisible();
});

it('shows one blocking reason as a single line with a way into Settings (UI-CLEANUP §5)', async () => {
  const user = userEvent.setup();
  caps = { ...defaults(), cloud_consent: false, has_api_key: false };
  const openSettings = vi.fn();
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} onOpenSettings={openSettings} />);

  const alerts = await screen.findAllByRole('alert');
  // The most fundamental reason only, not one box per problem.
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(/sends the audio file to Soniox/);
  await user.click(screen.getByRole('button', { name: 'Open settings' }));
  expect(openSettings).toHaveBeenCalled();
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
});

it('keeps the duplicate choice explicit next to Transcribe', async () => {
  const user = userEvent.setup();
  const preview = { title: 'Lecture', duration_ms: 60_000, source: { kind: 'youtube' as const, url: 'https://youtu.be/abcdefghijk' }, existing_session_ids: ['old'] };
  const openExisting = vi.fn();
  render(<Dialog file={{ path: '', url: '', name: 'Lecture' }} preview={preview} onClose={vi.fn()} onCreated={created} onOpenExisting={openExisting} />);

  const transcribe = await screen.findByRole('button', { name: 'Transcribe' });
  expect(transcribe).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Open existing' }));
  expect(openExisting).toHaveBeenCalledWith('old');
  await user.click(screen.getByRole('checkbox', { name: /Transcribe again/ }));
  expect(transcribe).toBeEnabled();
});
