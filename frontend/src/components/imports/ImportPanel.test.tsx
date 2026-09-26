import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { ImportView } from '../../api/types';

let Panel: typeof import('./ImportPanel')['ImportPanel'];
let requests: BridgeRequest[];
let states: ImportView[];
let onSettled: ReturnType<typeof vi.fn<(state: ImportView) => void>>;
let onDeleted: ReturnType<typeof vi.fn<() => void>>;

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
          data: { session: { id: 's1' }, import_state: view({ session_id: 's1', status: 'queued' }) } as T,
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

  expect(await screen.findByText('Provider is processing')).toBeVisible();
  // The name, not the path (UI-CLEANUP §4).
  expect(screen.getByRole('heading', { name: 'lecture.m4a' })).toBeVisible();
  expect(screen.queryByText('/Users/me/Downloads/lecture.m4a')).toBeNull();
  // One status line: status · elapsed · duration · mode.
  const line = screen.getByText('Provider is processing').closest('p')!;
  expect(line).toHaveTextContent('1 h 00 min');
  expect(line).toHaveTextContent('Transcription');
  expect(line).toHaveTextContent(/0:0\d/);
  // Soniox reports queued/processing/completed and nothing else: no percentage.
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(document.body.textContent).not.toMatch(/\d+ ?%/);
});

it('keeps caveats out of the running card: they appear where they matter', async () => {
  const user = userEvent.setup();
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);
  await screen.findByText('Provider is processing');
  expect(screen.queryByText(/may not stop provider charges/)).toBeNull();
  expect(screen.queryByText(/switch sessions/)).toBeNull();
  // The charge caveat is part of the cancel confirmation.
  await user.click(screen.getByRole('button', { name: 'Cancel import' }));
  expect(screen.getByRole('dialog', { name: 'Cancel import?' })).toHaveTextContent(/may not stop provider charges/);
});

it('cancels an in-flight import and reports the settled state upward', async () => {
  const user = userEvent.setup();
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: 'Cancel import' }));
  // Nothing is cancelled until confirmed.
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
  await user.click(within(screen.getByRole('dialog', { name: 'Cancel import?' })).getByRole('button', { name: 'Cancel import' }));

  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'cancelled' }),
  ));
  expect(requests.some((r) => r.method === 'POST' && r.path === '/imports/s1/cancel')).toBe(true);
});

it('says plainly that a cancelled import may still have been billed', async () => {
  states = [view({ status: 'cancelled', settled_at: 'now' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText(/may have charged/)).toBeVisible();
});

it('keeps the provider reason on failure and offers retry or delete, never auto-retry', async () => {
  states = [view({ status: 'failed', error: 'Soniox could not transcribe this file: audio_decode_failed' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByRole('alert')).toHaveTextContent('audio_decode_failed');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible();
  // The paid-retry caveat sits under Retry, only here.
  expect(screen.getByText(/a new paid transcription is created/)).toBeVisible();
  // Nothing was retried on its own: a new job costs money and needs a click.
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

it('retry announces the resumed session', async () => {
  const user = userEvent.setup();
  states = [view({ status: 'failed', error: 'bad file' })];
  const started = vi.fn();
  window.addEventListener('skaz-import-started', started);
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: /Retry/ }));

  await waitFor(() => expect(started).toHaveBeenCalled());
  window.removeEventListener('skaz-import-started', started);
});

it('deleting a settled import reports it upward', async () => {
  const user = userEvent.setup();
  states = [view({ status: 'failed', error: 'bad file' })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  await user.click(await screen.findByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(requests.some((r) => r.method === 'DELETE' && r.path === '/imports/s1')).toBe(true);
});

it('reports a missing source file without pretending the transcript is broken', async () => {
  states = [view({
    status: 'completed',
    source: { name: 'lecture.m4a', path: '/gone/lecture.m4a', size_bytes: 4096, available: false },
  })];
  render(<Panel sessionId="s1" onSettled={onSettled} onDeleted={onDeleted} />);

  expect(await screen.findByText(/not available at its previous path/)).toBeVisible();
  expect(screen.getByText(/notes keep working/)).toBeVisible();
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
