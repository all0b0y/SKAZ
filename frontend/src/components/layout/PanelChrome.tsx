import { useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import { PANEL_MIN, type PanelId } from '../../lib/panelLayout';
import type { PanelControls } from '../../hooks/usePanelLayout';

const LABELS: Record<PanelId, { open: string; closed: string; key: string }> = {
  sessions: { open: 'Hide sessions panel', closed: 'Show sessions panel', key: '⌘/' },
  assistant: { open: 'Hide assistant', closed: 'Show assistant', key: '⌘.' },
};

function PanelToggle({ id, panels }: { id: PanelId; panels: PanelControls }) {
  const open = panels.shown[id];
  const label = open ? LABELS[id].open : LABELS[id].closed;
  return (
    <button
      type="button"
      className={clsx('titlebar__btn', 'panel-toggle', open && 'panel-toggle--on')}
      onClick={() => panels.toggle(id)}
      aria-label={label}
      aria-pressed={open}
      title={`${label} (${LABELS[id].key})`}
    >
      {id === 'assistant'
        ? <Icon name="robot" size={17} filled={open} />
        : <Icon name="chevron" size={15} className={clsx('panel-toggle__chevron', open && 'panel-toggle__chevron--open')} />}
    </button>
  );
}

/**
 * Left end of the titlebar: the sessions toggle, and — only while that panel
 * is hidden — the two actions that otherwise live only inside it (§7).
 */
export function TitlebarLeading({ panels, onOpenSettings }: { panels: PanelControls; onOpenSettings: () => void }) {
  const recorderState = useStore((s) => s.recorderState);
  const newSession = useStore((s) => s.newSession);
  const [error, setError] = useState('');
  const capturing = recorderState === 'recording' || recorderState === 'paused' || recorderState === 'processing';
  return (
    <div className="titlebar__group">
      <PanelToggle id="sessions" panels={panels} />
      {!panels.shown.sessions && (
        <>
          <button
            type="button"
            className="titlebar__btn"
            onClick={() => {
              setError('');
              void newSession().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
            disabled={capturing}
            aria-label="New session"
            title={capturing ? 'Stop recording to start a new session' : 'New session'}
          >
            <Icon name="plus" size={16} />
          </button>
          <button type="button" className="titlebar__btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            <Icon name="settings" size={16} />
          </button>
          {error && <p role="alert" className="titlebar__error">{error}</p>}
        </>
      )}
    </div>
  );
}

export function TitlebarTrailing({ panels }: { panels: PanelControls }) {
  return <PanelToggle id="assistant" panels={panels} />;
}

const KEY_STEP = 16;

/**
 * The draggable border of a docked panel. Also a focusable separator: arrows
 * resize, Enter/double click restores the default width.
 */
export function PanelResizer({ id, panels }: { id: PanelId; panels: PanelControls }) {
  const view = panels.layout[id];
  if (!view.docked) return null;
  const grow = id === 'sessions' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = id === 'sessions' ? 'ArrowLeft' : 'ArrowRight';
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === grow) panels.nudge(id, KEY_STEP);
    else if (event.key === shrink) panels.nudge(id, -KEY_STEP);
    else if (event.key === 'Enter') panels.resetWidth(id);
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={id === 'sessions' ? 'Sessions panel width' : 'Assistant panel width'}
      aria-valuenow={view.width}
      aria-valuemin={PANEL_MIN[id]}
      tabIndex={0}
      className={clsx('panel-resizer', `panel-resizer--${id}`, panels.dragging === id && 'panel-resizer--active')}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => panels.startDrag(id, event)}
      onDoubleClick={() => panels.resetWidth(id)}
      onKeyDown={onKeyDown}
      title="Drag to resize. Double-click to reset the width"
    />
  );
}
