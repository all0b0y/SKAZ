import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type BannerTone = 'warning' | 'progress' | 'error';

const TONE_ICON: Record<BannerTone, IconName> = {
  warning: 'warning',
  progress: 'export',
  error: 'error',
};

export interface BannerProps {
  tone: BannerTone;
  /** Short reason in plain words, bold. */
  title: string;
  /** What does not work now and what keeps working. */
  children?: ReactNode;
  /** Real progress 0..100 for `progress`; never invented. Omit when unknown. */
  progress?: number;
  progressLabel?: string;
  actions?: ReactNode;
}

/**
 * Problem banner (decision 31 + "problem states"): the only coloured spot of a settings section.
 * Yellow = something is missing, progress = it is being fixed and you can keep working,
 * red = it failed, with the concrete reason. Errors interrupt (role="alert"); the rest is a status.
 */
export function Banner({ tone, title, children, progress, progressLabel, actions }: BannerProps) {
  const pct = progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className={`kb-banner kb-banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-tone={tone}>
      <Icon name={TONE_ICON[tone]} size={17} className="kb-banner__icon" />
      <div className="kb-banner__body">
        {/* A div, not a p: callers put icons in the text (Still works ✓ / Stopped ✕), and Hugeicons glyphs are divs. */}
        <div className="kb-banner__text">
          <b>{title}</b>
          {children ? <> {children}</> : null}
        </div>
        {tone === 'progress' && pct !== undefined && (
          <div
            className="kb-progress kb-progress--wide"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={progressLabel ?? title}
          >
            <i style={{ width: `${pct}%` }} />
          </div>
        )}
        {actions && <div className="kb-banner__actions">{actions}</div>}
      </div>
    </div>
  );
}
