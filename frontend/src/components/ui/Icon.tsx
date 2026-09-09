// One consistent icon set, drawn as SVG paths with a single stroke weight.
// No emoji or unicode glyphs standing in for icons (craft floor).

export type IconName =
  | 'mic'
  | 'pause'
  | 'stop'
  | 'play'
  | 'plus'
  | 'settings'
  | 'notes'
  | 'transcript'
  | 'search'
  | 'send'
  | 'trash'
  | 'retry'
  | 'chevron'
  | 'dot'
  | 'warning'
  | 'check';

const PATHS: Record<IconName, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6 6h12v12H6z',
  play: 'M8 5v14l11-7z',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.1a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 18.3a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.3 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 2.3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  notes: 'M8 4h9l3 3v13H8zM8 4H4v16h4M12 10h5M12 14h5',
  transcript: 'M4 6h16M4 10h12M4 14h16M4 18h9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  send: 'M4 12l16-8-6 16-3-6-7-2Z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v5h-5',
  chevron: 'M9 6l6 6-6 6',
  dot: 'M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  warning: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 13l4 4L19 7',
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}

export function Icon({ name, size = 18, className, filled }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
