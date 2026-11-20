import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';
import { m } from 'motion/react';
import { useMotionLevel } from './motionLevel';
import { StippleRing } from '../fx/stipple/StippleWork';
import type { Placement } from './geometry';

export type ButtonVariant = 'fill' | 'outline' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Feedback counter for the icon (see `Icon`'s `play`): each change plays its motion once. */
  iconPlay?: number;
  feedback?: boolean;
  /** Shown instead of the label's icon while a real request runs; the button stays the same size. */
  busy?: boolean;
  children?: ReactNode;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Text button. `fill` = primary (graphite fill), `outline`, `quiet` (text only), `danger` (outlined red). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', icon, iconPlay, busy = false, feedback = false, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('kb-btn', `kb-btn--${variant}`, `kb-btn--${size}`, feedback && 'kb-action-feedback', className)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <StippleRing className="kb-spinner kb-spinner--inline" />
        : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} play={iconPlay} /> : null}
      {children !== undefined && <span className="kb-btn__label">{children}</span>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Feedback counter for the icon (see `Icon`'s `play`): each change plays its motion once. */
  iconPlay?: number;
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
  { icon, iconPlay, label, size = 'md', active = false, tooltip = true, tooltipPlacement = 'bottom', badge, className,
    type = 'button', ...rest },
  ref,
) {
  const px = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const full = useMotionLevel() === 'full';
  const expanded = rest['aria-expanded'] === true;
  const menuIcon = icon === 'more' || icon === 'plus' && rest['aria-haspopup'] === 'menu';
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx('kb-iconbtn', `kb-iconbtn--${size}`, active && 'is-active', className)}
      {...rest}
    >
      {menuIcon || icon === 'share' ? (
        <m.span style={{ display: 'inline-flex' }} animate={{ rotate: full && expanded ? (icon === 'plus' ? 45 : 90) : 0 }}
          whileTap={full ? { scaleX: 1.08, scaleY: 0.91 } : undefined}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
          <Icon name={icon} size={px} play={iconPlay} />
        </m.span>
      ) : <Icon name={icon} size={px} play={iconPlay} />}
      {badge}
    </button>
  );
  return tooltip ? <Tooltip text={label} placement={tooltipPlacement}>{button}</Tooltip> : button;
});
