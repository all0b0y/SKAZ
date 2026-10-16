import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePanelLayout } from '../../hooks/usePanelLayout';
import { PanelResizer, TitlebarLeading, TitlebarTrailing } from './PanelChrome';
import { useStore } from '../../state/store';
import { CENTER_MIN, PANEL_DEFAULT, PANEL_MIN, STORAGE_KEY } from '../../lib/panelLayout';

/** The real hook and chrome, with the panel state exposed as data attributes. */
function Harness({ onOpenSettings = vi.fn() }: { onOpenSettings?: () => void }) {
  const panels = usePanelLayout();
  return (
    <div>
      <TitlebarLeading panels={panels} onOpenSettings={onOpenSettings} />
      <TitlebarTrailing panels={panels} />
      {(['sessions', 'assistant'] as const).map((id) => (
        <div
          key={id}
          data-testid={id}
          data-docked={String(panels.layout[id].docked)}
          data-overlay={String(panels.layout[id].overlay)}
          data-width={panels.layout[id].width}
        />
      ))}
      <PanelResizer id="sessions" panels={panels} />
      <PanelResizer id="assistant" panels={panels} />
      <button type="button" onClick={panels.dismissOverlay}>dismiss overlay</button>
    </div>
  );
}

const setWindowWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
};

const panel = (id: 'sessions' | 'assistant') => screen.getByTestId(id);
const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  useStore.setState({ recorderState: 'idle', newSession: vi.fn(async () => undefined) });
});

describe('panel toggles', () => {
  it('toggles the assistant with one robot button that reports its state', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Hide assistant' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'false');
    const reopen = screen.getByRole('button', { name: 'Show assistant' });
    expect(reopen).toHaveAttribute('aria-pressed', 'false');
    await user.click(reopen);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'true');
  });

  it('toggles the panels with ⌘/ and ⌘.', () => {
    render(<Harness />);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true })); });
    expect(panel('sessions')).toHaveAttribute('data-docked', 'false');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true })); });
    expect(panel('assistant')).toHaveAttribute('data-docked', 'false');
    // Without the modifier the keys are just typing.
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' })); });
    expect(panel('sessions')).toHaveAttribute('data-docked', 'false');
  });

  it('puts New session and Settings in the titlebar only while the sessions panel is hidden', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const newSession = vi.fn(async () => undefined);
    useStore.setState({ newSession });
    render(<Harness onOpenSettings={onOpenSettings} />);
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide sessions panel' }));
    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(newSession).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Show sessions panel' }));
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('disables the titlebar New session with the reason while recording', async () => {
    useStore.setState({ recorderState: 'recording' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Hide sessions panel' }));
    const button = screen.getByRole('button', { name: 'New session' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Stop recording to start a new session');
  });
});

describe('dragging a border', () => {
  const drag = (id: 'sessions' | 'assistant', dx: number) => {
    const handle = screen.getByRole('separator', {
      name: id === 'sessions' ? 'Sessions panel width' : 'Assistant panel width',
    });
    // jsdom has no PointerEvent; a MouseEvent carrying the pointer type name
    // reaches React's onPointerDown with real button/clientX values.
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 500 }));
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 + dx, buttons: 1 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 500 + dx })); });
  };

  it('stops following a pointer whose button was released outside the window', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Sessions panel width' });
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 500 }));
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 530, buttons: 1 })); });
    // No pointerup ever arrives; the next move has no button held.
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, buttons: 0 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 720, buttons: 1 })); });
    expect(panel('sessions')).toHaveAttribute('data-width', String(PANEL_DEFAULT.sessions + 30));
    expect(saved().sessions.width).toBe(PANEL_DEFAULT.sessions + 30);
  });

  it('resizes the sessions panel and remembers the width', () => {
    render(<Harness />);
    drag('sessions', 40);
    expect(panel('sessions')).toHaveAttribute('data-width', String(PANEL_DEFAULT.sessions + 40));
    expect(saved().sessions).toEqual({ open: true, width: PANEL_DEFAULT.sessions + 40 });
  });

  it('grows the assistant when its border moves left', () => {
    render(<Harness />);
    drag('assistant', -50);
    expect(panel('assistant')).toHaveAttribute('data-width', String(PANEL_DEFAULT.assistant + 50));
  });

  it('collapses a panel dragged far past its minimum and flips its toggle', () => {
    render(<Harness />);
    drag('assistant', PANEL_DEFAULT.assistant - PANEL_MIN.assistant + 61);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'false');
    expect(screen.getByRole('button', { name: 'Show assistant' })).toBeInTheDocument();
    expect(saved().assistant.open).toBe(false);
  });

  it('restores the default width on double click', () => {
    render(<Harness />);
    drag('sessions', 80);
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Sessions panel width' }));
    expect(panel('sessions')).toHaveAttribute('data-width', String(PANEL_DEFAULT.sessions));
  });
});

describe('narrow windows', () => {
  it('auto-closes the assistant first and brings it back when the window widens', () => {
    render(<Harness />);
    setWindowWidth(CENTER_MIN + PANEL_MIN.sessions + PANEL_MIN.assistant - 10);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'false');
    expect(panel('sessions')).toHaveAttribute('data-docked', 'true');
    expect(screen.getByRole('button', { name: 'Show assistant' })).toBeInTheDocument();
    // The remembered choice was not overwritten by the narrow window.
    expect(saved().assistant.open).toBe(true);
    setWindowWidth(1600);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'true');
  });

  it('floats an assistant explicitly opened in a window too narrow to dock it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setWindowWidth(CENTER_MIN + PANEL_MIN.sessions + 50);
    await user.click(screen.getByRole('button', { name: 'Show assistant' }));
    expect(panel('assistant')).toHaveAttribute('data-overlay', 'true');
    expect(screen.getByRole('button', { name: 'Hide assistant' })).toBeInTheDocument();
    setWindowWidth(1600);
    expect(panel('assistant')).toHaveAttribute('data-overlay', 'false');
    expect(panel('assistant')).toHaveAttribute('data-docked', 'true');
  });
});

describe('persistence', () => {
  it('restores the remembered layout on the next start', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessions: { open: false, width: 300 }, assistant: { open: true, width: 420 },
    }));
    render(<Harness />);
    expect(panel('sessions')).toHaveAttribute('data-docked', 'false');
    expect(panel('assistant')).toHaveAttribute('data-width', '420');
  });
});

describe('floating panel dismissal (PANES-SPEC §6)', () => {
  it('puts the overlay away without forgetting the panel is open, so a wide window docks it again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    setWindowWidth(820);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'false');
    await user.click(screen.getByRole('button', { name: 'Show assistant' }));
    expect(panel('assistant')).toHaveAttribute('data-overlay', 'true');
    await user.click(screen.getByRole('button', { name: 'dismiss overlay' }));
    expect(panel('assistant')).toHaveAttribute('data-overlay', 'false');
    expect(saved().assistant.open).toBe(true);
    setWindowWidth(1600);
    expect(panel('assistant')).toHaveAttribute('data-docked', 'true');
  });
});
