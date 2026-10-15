import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** Only for a real wait (a request in flight). Never a fake progress indicator. */
export function Spinner({ label, size = 'md' }: { label: string; size?: 'sm' | 'md' }) {
  return (
    <span role="status" className={`kb-spinner-wrap kb-spinner-wrap--${size}`}>
      <span className="kb-spinner" aria-hidden="true" />
      <span className="kb-visually-hidden">{label}</span>
    </span>
  );
}

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, children, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`kb-empty${compact ? ' kb-empty--compact' : ''}`}>
      <Icon name={icon} size={compact ? 18 : 22} className="kb-empty__icon" />
      <p className="kb-empty__title">{title}</p>
      {children && <p className="kb-empty__text">{children}</p>}
      {action && <div className="kb-empty__action">{action}</div>}
    </div>
  );
}
