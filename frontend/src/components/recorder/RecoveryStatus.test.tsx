import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RecoveryStatus } from './RecoveryStatus';

it('shows the backend retry attempt and removes the notice on pause', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, status: 200,
    data: { state: 'reconnecting', attempt: 2, max_attempts: 3 } });
  window.audiohelper = { ...window.audiohelper, request };
  const view = render(<RecoveryStatus sessionId="s1" active />);
  expect(await screen.findByRole('status')).toHaveTextContent('Attempt 2/3');
  expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/sessions/s1/live/status' });
  view.rerender(<RecoveryStatus sessionId="s1" active={false} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
});
