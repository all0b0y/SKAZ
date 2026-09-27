import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';

let TranscriptView: typeof import('./TranscriptView')['TranscriptView'];
let useStore: typeof import('../../state/store')['useStore'];
let releaseEvents: (() => void) | null;

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); releaseEvents = null;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.skaz = { ...window.skaz, request: vi.fn(async (req: BridgeRequest) => {
    // The first native page stays in flight until the test releases it.
    if (req.path === '/sessions/saved/live/events') {
      await new Promise<void>((resolve) => { releaseEvents = resolve; });
    }
    return { ok: false, status: 404, detail: 'Not found' } as never;
  }) };
  useStore = (await import('../../state/store')).useStore;
  useStore.setState({ activeSessionId: 'saved', recorderState: 'idle', sessions: [],
    detail: null, detailLoading: true, detailError: null });
  TranscriptView = (await import('./TranscriptView')).TranscriptView;
});
afterEach(() => { vi.useRealTimers(); });

it('shows nothing for a fast open, then the animated loader after 300 ms', async () => {
  render(<TranscriptView focusSegmentId={null} />);
  expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();
  expect(screen.queryByText('Loading transcript…')).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(299); });
  expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1); });
  const loader = screen.getByRole('status', { name: 'Loading transcript' });
  expect(loader.querySelector('.transcript-loading__arc')).not.toBeNull();
});

it('never flashes the loader when the session opens within 300 ms', async () => {
  render(<TranscriptView focusSegmentId={null} />);
  await act(async () => { vi.advanceTimersByTime(200); });
  await act(async () => { useStore.setState({ detailLoading: false, detail: { segments: [], messages: [], notes: null } }); releaseEvents?.(); });
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();
});

it('keeps the loader while the first transcript page is still loading instead of the empty wordmark', async () => {
  useStore.setState({ detailLoading: false, detail: { segments: [], messages: [], notes: null } });
  render(<TranscriptView focusSegmentId={null} />);
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(screen.getByRole('status', { name: 'Loading transcript' })).toBeInTheDocument();
  expect(screen.queryByText('Record or open a session to see its transcript here.')).not.toBeInTheDocument();
  await act(async () => { releaseEvents?.(); });
  await act(async () => { vi.advanceTimersByTime(50); });
  expect(screen.queryByRole('status', { name: 'Loading transcript' })).not.toBeInTheDocument();
});
