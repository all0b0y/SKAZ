import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';
import type { Placement } from './geometry';

export type ButtonVariant = 'fill' | 'outline' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shown instead of the label's icon while a real request runs; the button stays the same size. */
  busy?: boolean;
  children?: ReactNode;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Text button. `fill` = primary (graphite fill), `outline`, `quiet` (text only), `danger` (outlined red). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', icon, busy = false, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('kb-btn', `kb-btn--${variant}`, `kb-btn--${size}`, className)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="kb-spinner kb-spinner--inline" aria-hidden="true" />
        : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children !== undefined && <span className="kb-btn__label">{children}</span>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name and tooltip text. Required: an icon alone never names a control. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  /** Pressed/selected look for toggles (pair with aria-pressed or aria-current). */
  active?: boolean;
  tooltip?: boolean;
  tooltipPlacement?: Placement;
  badge?: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', active = false, tooltip = true, tooltipPlacement = 'bottom', badge, className,
    type = 'button', ...rest },
  ref,
) {
  const px = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx('kb-iconbtn', `kb-iconbtn--${size}`, active && 'is-active', className)}
      {...rest}
    >
      <Icon name={icon} size={px} />
      {badge}
    </button>
  );
  return tooltip ? <Tooltip text={label} placement={tooltipPlacement}>{button}</Tooltip> : button;
});
