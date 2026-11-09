import type { SyntheticEvent } from 'react';
import { CompassIcon as LucideCompassIcon } from '@animateicons/react/lucide/compass-icon';
import { Compass01Icon as HugeCompass01Icon } from '@animateicons/react/huge/compass-0-1-icon';

const stop = (event: SyntheticEvent) => {
  event.stopPropagation();
};

export interface CompassIconProps {
  size?: number;
  variant?: 'lucide' | 'huge';
  label?: string;
  className?: string;
}

/**
 * Compass glyph from `@animateicons/react` (`compass-icon` / `compass-0-1-icon`), matching `Icon.tsx`
 * without editing the shared `Icon.tsx` file owned by F1.
 */
export function CompassIcon({ size = 16, variant = 'lucide', label, className }: CompassIconProps) {
  const IconComp = variant === 'huge' ? HugeCompass01Icon : LucideCompassIcon;
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-icon="compass"
      style={{ width: size, height: size }}
      className={`kb-icon kb-icon--lib${className ? ` ${className}` : ''}`}
      onMouseEnter={stop}
      onMouseLeave={stop}
      onFocus={stop}
      onBlur={stop}
      onClickCapture={stop}
    >
      <IconComp size={size} isAnimated={false} />
    </span>
  );
}
