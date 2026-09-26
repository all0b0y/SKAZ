import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { BridgeApi } from '../../api/bridge';
import { MediaImportDialog } from './MediaImportDialog';

it('opens before a source is chosen, previews a URL, and starts only after confirmation', async () => {
  const request = vi.fn(async (req) => ({ ok: true, status: 200, data: req.path === '/imports/preview'
    ? { title: 'Lecture', duration_ms: 60000, source: req.body.source, existing_session_ids: [] }
    : req.method === 'GET' ? { cloud_consent: true, has_api_key: true, active_imports: 0,
      max_concurrent_imports: 1, max_duration_ms: 18000000, rate_per_hour_usd: 0.1,
      translation_rate_per_hour_usd: 0.15, destination: 'Internal storage' }
      : { session: { id: 'new' }, import_state: { status: 'queued' } } }));
  window.audiohelper = { ...window.audiohelper, request: request as BridgeApi['request'], chooseAudioFile: vi.fn(async () => null) };
  const created = vi.fn();
  render(<MediaImportDialog onClose={vi.fn()} onCreated={created} onOpenExisting={vi.fn()} />);
  expect(window.audiohelper.chooseAudioFile).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Choose file' })).toBeVisible();
  // No "Check link": a YouTube link is checked by itself (UI-CLEANUP §5).
  expect(screen.queryByRole('button', { name: 'Check link' })).toBeNull();
  fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: 'https://youtu.be/abcdefghijk' } });
  expect(await screen.findByDisplayValue('Lecture', {}, { timeout: 3000 })).toBeVisible();
  // The source collapses to one line with Change; the picker is not repeated.
  expect(screen.getByRole('button', { name: 'Change' })).toBeVisible();
  expect(screen.queryByLabelText('YouTube link')).toBeNull();
  expect(created).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
  await waitFor(() => expect(created).toHaveBeenCalled());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: '/imports', body: expect.objectContaining({
    source: { kind: 'youtube', url: 'https://youtu.be/abcdefghijk' },
  }) }));
});
