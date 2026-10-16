import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'ghost' | 'quiet' | 'live' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  iconFilled?: boolean;
}

export function Button({
  variant = 'ghost',
  icon,
  iconFilled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button className={clsx('btn', `btn--${variant}`, !children && 'btn--icon', className)} {...rest}>
      {icon && <Icon name={icon} filled={iconFilled} />}
      {children && <span>{children}</span>}
    </button>
  );
}
