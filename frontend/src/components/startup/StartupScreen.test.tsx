import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BridgeApi } from '../../api/bridge';
import { ROOT_CELLS, SAP } from '../../brand/treeGeometry';
import { useStore } from '../../state/store';
import { SLOW_START_MS, StartupScreen } from './StartupScreen';

const restartBackend = vi.fn(async () => true);
const openLogsFolder = vi.fn(async () => true);
let saved: Pick<BridgeApi, 'restartBackend' | 'openLogsFolder'>;

beforeEach(() => {
  restartBackend.mockClear();
  openLogsFolder.mockClear();
  saved = { restartBackend: window.skaz.restartBackend, openLogsFolder: window.skaz.openLogsFolder };
  Object.assign(window.skaz, { restartBackend, openLogsFolder });
  useStore.setState({ ready: false, backend: { phase: 'starting' } });
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(window.skaz, saved);
});

describe('StartupScreen', () => {
  it('starts with the tree and the wave only; the status is for VoiceOver', () => {
    const { container } = render(<StartupScreen />);
    expect(container.querySelector('.gate.startup')).not.toBeNull();
    expect(container.querySelectorAll('.tree-mark__roots rect')).toHaveLength(ROOT_CELLS.length);
    expect(container.querySelectorAll('.startup__sap rect')).toHaveLength(SAP.trunk.length + SAP.branches.length);
    expect(container.querySelectorAll('.startup__wave span')).toHaveLength(23);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Starting SKAZ…');
    expect(status).toHaveClass('visually-hidden');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Still starting the local service…')).not.toBeInTheDocument();
  });

  it('adds one quiet line only when the start takes longer than usual', () => {
    vi.useFakeTimers();
    render(<StartupScreen />);
    act(() => { vi.advanceTimersByTime(SLOW_START_MS - 1); });
    expect(screen.queryByText('Still starting the local service…')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText('Still starting the local service…')).toBeInTheDocument();
  });

  it('explains a failed start and offers Try again and Open logs', () => {
    useStore.setState({ backend: { phase: 'error', detail: 'backend exited (code 1, signal none)' } });
    render(<StartupScreen />);
    expect(screen.getByRole('heading', { name: 'The backend didn’t start' })).toBeInTheDocument();
    expect(screen.getByText('backend exited (code 1, signal none)')).toBeInTheDocument();
    expect(screen.queryByText(/uv sync/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(restartBackend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it('shows the development hint only when the app provides one', () => {
    useStore.setState({ backend: { phase: 'error', detail: 'x', hint: 'Development build: run uv sync in backend/.' } });
    render(<StartupScreen />);
    expect(screen.getByText('Development build: run uv sync in backend/.')).toBeInTheDocument();
  });

  it('gets out of the way as soon as the backend is ready, and returns if it later fails', async () => {
    const { container } = render(<StartupScreen />);
    act(() => { useStore.setState({ ready: true, backend: { phase: 'ready' } }); });
    await waitFor(() => expect(container.querySelector('.gate')).toBeNull());

    act(() => { useStore.setState({ ready: false, backend: { phase: 'error', detail: 'backend exited (code 9, signal none)' } }); });
    expect(await screen.findByRole('heading', { name: 'The backend didn’t start' })).toBeInTheDocument();
  });
});
