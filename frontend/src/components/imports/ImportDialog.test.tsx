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
    destination: 'Внутреннее хранилище приложения (экспорт в папку не включён)',
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
  expect(await screen.findByText('1 ч 00 мин')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'Транскрибировать' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
  expect(requests.filter((r) => r.method === 'POST')).toEqual([{
    method: 'POST', path: '/imports',
    body: { path: FILE.path, title: 'lecture', translate: false, declared_duration_ms: 3_600_000 },
  }]);
});

it('prices transcription and translation from the advertised rates', async () => {
  const user = userEvent.setup();
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText(/≈ \$0\.10/)).toBeVisible();
  await user.click(screen.getByLabelText('Транскрипция и перевод'));
  expect(await screen.findByText(/≈ \$0\.15/)).toBeVisible();
});

it('says the estimate is an estimate and where the result lands', async () => {
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText(/Оценка, а не счёт/)).toBeVisible();
  expect(screen.getByText(/экспорт в папку не включён/)).toBeVisible();
});

it('falls back to the rate alone when the duration cannot be read', async () => {
  duration = null;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText('не удалось прочитать из файла')).toBeVisible();
  expect(screen.getByText(/точную сумму покажем после обработки/)).toBeVisible();
});

it('requires a second click above the cost threshold and sends nothing on the first', async () => {
  const user = userEvent.setup();
  duration = 4 * 3_600_000; // four hours ≈ $0.40, over the $0.30 threshold
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  await screen.findByText('4 ч 00 мин');
  // The price warning is visible before any click; the button still reads normally.
  expect(await screen.findByRole('alert')).toHaveTextContent(/дороже вашего порога \$0\.30/);
  await user.click(screen.getByRole('button', { name: 'Транскрибировать' }));

  expect(requests.some((r) => r.method === 'POST')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Всё равно транскрибировать' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
});

it('re-arms the confirmation when the price changes under the user', async () => {
  const user = userEvent.setup();
  duration = 4 * 3_600_000;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  await screen.findByText('4 ч 00 мин');
  await user.click(screen.getByRole('button', { name: 'Транскрибировать' }));
  await screen.findByRole('button', { name: 'Всё равно транскрибировать' });

  // Switching to translation makes it more expensive: the confirmation must reset.
  await user.click(screen.getByLabelText('Транскрипция и перевод'));
  expect(await screen.findByRole('button', { name: 'Транскрибировать' })).toBeVisible();
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
});

it('explains missing cloud consent instead of silently disabling itself', async () => {
  caps = { ...defaults(), cloud_consent: false };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/отправляет аудиофайл в Soniox/);
  expect(screen.getByRole('button', { name: 'Транскрибировать' })).toBeDisabled();
});

it('explains a missing API key', async () => {
  caps = { ...defaults(), has_api_key: false };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/ключ Soniox/);
});

it('refuses a file longer than the provider limit', async () => {
  duration = 301 * 60 * 1000;
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  const alerts = await screen.findAllByRole('alert');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(/провайдер такие не принимает/);
  expect(screen.getByRole('button', { name: 'Транскрибировать' })).toBeDisabled();
});

it('warns that a fourth import will queue', async () => {
  caps = { ...defaults(), active_imports: 3 };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText(/встанет в очередь/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Транскрибировать' })).toBeEnabled();
});

it('shows the real Markdown destination when the projection is on', async () => {
  caps = { ...defaults(), markdown_enabled: true, destination: '/Users/me/Documents/SKAZ' };
  render(<Dialog file={FILE} onClose={vi.fn()} onCreated={created} />);

  expect(await screen.findByText('/Users/me/Documents/SKAZ')).toBeVisible();
});
