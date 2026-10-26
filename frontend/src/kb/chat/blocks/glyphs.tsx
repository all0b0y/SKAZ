import type { ReactNode } from 'react';

/**
 * Small glyphs only blocks use, drawn as SKAZ's own SVG (no icon set has them in `ui/Icon`):
 * the arrows of a cause chain and between blocks, the calendar of an action item's due date.
 * Decorative: the words next to them carry the meaning.
 */
function Glyph({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg className="kb-blk-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const ArrowRight = ({ size = 16 }: { size?: number }) => <Glyph size={size}><path d="M5 12h14M13 6l6 6-6 6" /></Glyph>;
export const ArrowDown = ({ size = 14 }: { size?: number }) => <Glyph size={size}><path d="M12 5v14M6 13l6 6 6-6" /></Glyph>;
export const Calendar = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Glyph>
);
