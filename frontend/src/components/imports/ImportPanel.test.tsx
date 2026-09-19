import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { ImportView } from '../../api/types';

let Panel: typeof import('./ImportPanel')['ImportPanel'];
let requests: BridgeRequest[];
let states: ImportView[];
let onSettled: ReturnType<typeof vi.fn>;
let onDeleted: ReturnType<typeof vi.fn>;

function view(over: Partial<ImportView> = {}): ImportView {
  return {
    session_id: 's1',
    status: 'processing',
    source: { name: 'lecture.m4a', path: '/Users/me/Downloads/lecture.m4a', size_bytes: 4096, available: true },
    translate: false,
    model: 'stt-async-v5',
    declared_duration_ms: 3_600_000,
    audio_duration_ms: null,
    error: null,
    created_at: new Date().toISOString(),
    settled_at: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.resetModules();
  requests = [];
  states = [view()];
  onSettled = vi.fn();
  onDeleted = vi.fn();
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      requests.push(req);
      if (req.method === 'POST' && req.path.endsWith('/cancel')) {
        return { ok: true, status: 200, data: view({ status: 'cancelled', settled_at: 'now' }) as T };
      }
      if (req.method === 'POST' && req.path.endsWith('/retry')) {
        return {
          ok: true, status: 201,
          data: { session: { id: 's2' }, import_state: view({ session_id: 's2', status: 'queued' }) } as T,
        };
      }
      if (req.method === 'DELETE') return { ok: true, status: 200, data: { deleted: true } as T };
      return { ok: true, status: 200, data: (states.length > 1 ? states.shift()! : states[0]!) as T };
    },
  };
  Panel = (await import('./ImportPanel')).ImportPanel;
});

afterEach(() => { vi.unstubAllGlobals(); });

it('shows the provider status and elapsed time, never an invented percentage', async () => {
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText('Провайдер обрабатывает')).toBeVisible();
  expect(screen.getByText('lecture.m4a')).toBeVisible();
  expect(screen.getByText('1 ч 00 мин')).toBeVisible();
  expect(screen.getByText('Только транскрипция')).toBeVisible();
  // Soniox reports queued/processing/completed and nothing else.
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText(/Точного процента провайдер не сообщает/)).toBeVisible();
});

it('tells the user the app may be closed while the provider works', async () => {
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText(/Приложение можно закрыть/)).toBeVisible();
});

it('cancels an in-flight import and reports the settled state upward', async () => {
  const user = userEvent.setup();
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: 'Отменить импорт' }));

  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'cancelled' }),
  ));
  expect(requests.some((r) => r.method === 'POST' && r.path === '/imports/s1/cancel')).toBe(true);
});

it('says plainly that a cancelled import may still have been billed', async () => {
  states = [view({ status: 'cancelled', settled_at: 'now' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText(/могла быть тарифицирована/)).toBeVisible();
});

it('keeps the provider reason on failure and offers retry or delete, never auto-retry', async () => {
  states = [view({ status: 'failed', error: 'Soniox could not transcribe this file: audio_decode_failed' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByRole('alert')).toHaveTextContent('audio_decode_failed');
  expect(screen.getByRole('button', { name: /Повторить \(новый платный запуск\)/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Удалить сессию' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Отменить импорт' })).toBeNull();
  // Nothing was retried on its own: a new job costs money and needs a click.
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

it('retry announces the new session instead of silently replacing this one', async () => {
  const user = userEvent.setup();
  states = [view({ status: 'failed', error: 'bad file' })];
  const started = vi.fn();
  window.addEventListener('skaz-import-started', started);
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: /Повторить/ }));

  await waitFor(() => expect(started).toHaveBeenCalled());
  window.removeEventListener('skaz-import-started', started);
});

it('deleting a settled import reports it upward', async () => {
  const user = userEvent.setup();
  states = [view({ status: 'failed', error: 'bad file' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: 'Удалить сессию' }));

  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(requests.some((r) => r.method === 'DELETE' && r.path === '/imports/s1')).toBe(true);
});

it('reports a missing source file without pretending the transcript is broken', async () => {
  states = [view({
    status: 'completed',
    source: { name: 'lecture.m4a', path: '/gone/lecture.m4a', size_bytes: 4096, available: false },
  })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText(/Недоступен по прежнему пути/)).toBeVisible();
  expect(screen.getByText(/заметки продолжают работать/)).toBeVisible();
});

it('stops polling once the import has settled', async () => {
  states = [view({ status: 'processing' }), view({ status: 'completed', audio_duration_ms: 3_500_000 })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'completed' }),
  ), { timeout: 4000 });
  const seen = requests.filter((r) => r.method === 'GET').length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(requests.filter((r) => r.method === 'GET').length).toBe(seen);
});
