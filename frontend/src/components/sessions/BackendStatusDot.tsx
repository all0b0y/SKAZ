import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';

// Backend lifecycle indicator. It lives in the titlebar as a single dot: the
// colour carries the phase and the tooltip spells it out, so the status is
// always visible without spending a line of chrome on it.

export function BackendStatusDot() {
  const backend = useStore((s) => s.backend);
  const label =
    backend.phase === 'ready'
      ? 'Backend ready'
      : backend.phase === 'starting'
        ? 'Starting backend…'
        : backend.phase === 'error'
          ? 'Backend error'
          : 'Backend stopped';

  return (
    <span
      className={clsx('status-pill', 'status-pill--compact', `status-pill--${backend.phase}`)}
      title={backend.detail ? `${label} — ${backend.detail}` : label}
      role="status"
      aria-label={label}
    >
      <Icon name="dot" size={11} filled />
    </span>
  );
}
