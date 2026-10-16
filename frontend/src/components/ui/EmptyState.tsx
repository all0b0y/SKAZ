import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface EmptyStateProps {
  icon: IconName;
  title: string;
  hint?: string;
  children?: ReactNode;
}

export function EmptyState({ icon, title, hint, children }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__mark">
        <Icon name={icon} size={26} />
      </div>
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
      {children}
    </div>
  );
}
