// One consistent icon set, drawn as SVG paths with a single stroke weight.
// No emoji or unicode glyphs standing in for icons (craft floor).

export type IconName =
  | 'mic'
  | 'pause'
  | 'stop'
  | 'play'
  | 'plus'
  | 'more'
  | 'settings'
  | 'sliders'
  | 'notes'
  | 'pencil'
  | 'transcript'
  | 'search'
  | 'send'
  | 'trash'
  | 'retry'
  | 'chevron'
  | 'dot'
  | 'warning'
  | 'check'
  | 'close';

const PATHS: Record<IconName, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6 6h12v12H6z',
  play: 'M8 5v14l11-7z',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.2 14.6a1.4 1.4 0 0 0 .3 1.5l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.4 1.4 0 0 0-1.5-.3 1.4 1.4 0 0 0-.9 1.3v.2a1.7 1.7 0 1 1-3.4 0v-.1a1.4 1.4 0 0 0-.9-1.3 1.4 1.4 0 0 0-1.5.3l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.4 1.4 0 0 0 .3-1.5 1.4 1.4 0 0 0-1.3-.9h-.2a1.7 1.7 0 1 1 0-3.4h.1a1.4 1.4 0 0 0 1.3-.9 1.4 1.4 0 0 0-.3-1.5l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.4 1.4 0 0 0 1.5.3h.1a1.4 1.4 0 0 0 .9-1.3v-.2a1.7 1.7 0 1 1 3.4 0v.1a1.4 1.4 0 0 0 .9 1.3 1.4 1.4 0 0 0 1.5-.3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.4 1.4 0 0 0-.3 1.5v.1a1.4 1.4 0 0 0 1.3.9h.2a1.7 1.7 0 1 1 0 3.4h-.1a1.4 1.4 0 0 0-1.3.9Z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  notes: 'M8 4h9l3 3v13H8zM8 4H4v16h4M12 10h5M12 14h5',
  pencil: 'M4 20h4L19.3 8.7a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20ZM14.8 6.5l2.7 2.7',
  transcript: 'M4 6h16M4 10h12M4 14h16M4 18h9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  send: 'M4 12l16-8-6 16-3-6-7-2Z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v5h-5',
  chevron: 'M9 6l6 6-6 6',
  dot: 'M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  warning: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 13l4 4L19 7',
  close: 'M6 6l12 12M18 6L6 18',
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
