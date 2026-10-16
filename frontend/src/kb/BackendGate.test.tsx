// The startup gate (BackendGate in KbApp): the tree while the local service starts, the app the
// moment it is ready (the tree fades out over it), the tree with the error and its buttons when
// the start fails; Try again starts the animation over.
import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import type { BackendStatus } from '../api/bridge';
import { KbApp } from './KbApp';
import { createServices } from './state/context';
import { PREFS_KEY } from './state/prefs';
import { createFakeBridge } from './test/fakeBridge';

async function renderGate(options: { initial?: BackendStatus; restart?: boolean; logs?: boolean } = {}) {
  localStorage.clear();
  localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true }));
  const fake = createFakeBridge();
  let listener: ((s: BackendStatus) => void) | null = null;
  let answer: (s: BackendStatus) => void = () => undefined;
  const first = new Promise<BackendStatus>((resolve) => { answer = resolve; });
  const restartBackend = vi.fn(async () => true);
  const openLogsFolder = vi.fn(async () => true);
  Object.assign(fake.bridge, {
    getBackendStatus: vi.fn(() => first),
    onBackendStatus: (fn: (s: BackendStatus) => void) => { listener = fn; return () => { listener = null; }; },
    ...(options.restart === false ? {} : { restartBackend }),
    ...(options.logs === false ? {} : { openLogsFolder }),
  });
  const services = createServices(fake.bridge, localStorage, { capture: null });
  const view = render(<KbApp services={services} />);
  if (options.initial) await act(async () => { answer(options.initial!); await first; });
  const emit = (s: BackendStatus) => act(() => listener?.(s));
  return { ...view, emit, answer, restartBackend, openLogsFolder };
}

const tree = () => screen.getByTestId('loading-tree');

describe('Startup gate', () => {
  it('starting: the tree, an accessible "Starting SKAZ…" status, no app yet', async () => {
    await renderGate();
    expect(tree()).toHaveAttribute('data-phase', 'starting');
    expect(screen.getByRole('status')).toHaveTextContent('Starting SKAZ…');
    expect(screen.queryByTestId('message-input')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ready: the app mounts at once and the tree fades out over it, then leaves', async () => {
    const { emit } = await renderGate({ initial: { phase: 'starting' } });
    emit({ phase: 'ready', detail: '127.0.0.1:1' });
    // No artificial delay: the app is there in the same render as the fade-out.
    expect(tree()).toHaveAttribute('data-phase', 'ready');
    expect(tree()).toHaveAttribute('aria-hidden', 'true');
    expect(await screen.findByTestId('message-input')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('loading-tree')).toBeNull(), { timeout: 2000 });
  });

  it('error: amber tree with the service\'s own reason, Try again and Open logs folder', async () => {
    const user = userEvent.setup();
    const { emit, restartBackend, openLogsFolder } = await renderGate({ initial: { phase: 'starting' } });
    const svgBefore = tree().querySelector('svg');
    emit({ phase: 'error', detail: 'backend exited (code 1, signal none)' });
    expect(tree()).toHaveAttribute('data-phase', 'error');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('SKAZ couldn’t start its local service.');
    expect(alert).toHaveTextContent('backend exited (code 1, signal none)');
    expect(alert.closest('.skaz-loading__message')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.click(within(alert).getByRole('button', { name: 'Open logs folder' }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(restartBackend).toHaveBeenCalledTimes(1);
    // The animation starts over at once, before main reports the new start.
    expect(tree()).toHaveAttribute('data-phase', 'starting');
    expect(screen.getByRole('status')).toHaveTextContent('Starting SKAZ…');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(tree().querySelector('svg')).not.toBe(svgBefore));
  });

  it('a stop counts as a failure too; without the bridge actions there are no buttons', async () => {
    await renderGate({ initial: { phase: 'stopped' }, restart: false, logs: false });
    expect(tree()).toHaveAttribute('data-phase', 'error');
    expect(within(screen.getByRole('alert')).queryAllByRole('button')).toHaveLength(0);
  });

  it('a status event that arrives before the first answer is not overwritten by that stale answer', async () => {
    const { emit, answer } = await renderGate();
    emit({ phase: 'error', detail: 'backend exited (code 1, signal none)' });
    await act(async () => { answer({ phase: 'starting' }); await Promise.resolve(); });
    expect(tree()).toHaveAttribute('data-phase', 'error');
  });

  it('a backend that stops after the app was shown takes the app away and shows the error', async () => {
    const { emit } = await renderGate({ initial: { phase: 'ready' } });
    expect(await screen.findByTestId('message-input')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('loading-tree')).toBeNull(), { timeout: 2000 });
    emit({ phase: 'error', detail: 'backend exited (code null, signal SIGKILL)', stopped: true });
    expect(tree()).toHaveAttribute('data-phase', 'error');
    expect(screen.queryByTestId('message-input')).toBeNull();
    // QA E16: it ran and stopped — not "couldn't start".
    expect(screen.getByRole('alert')).toHaveTextContent('SKAZ’s local service stopped.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('couldn’t start');
  });
});
