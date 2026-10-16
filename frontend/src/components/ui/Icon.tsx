import { useId } from 'react';
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
  | 'upload'
  | 'chevron'
  | 'dot'
  | 'warning'
  | 'check'
  | 'close'
  | 'robot'
  | 'arrow-down'
  | 'waveform'
  | 'nodes'
  | 'key'
  | 'globe'
  | 'folder'
  | 'terminal'
  | 'external'
  | 'monitor';

const ROBOT_EYES = 'M9 14m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M15 14m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0';

const PATHS: Record<IconName, string> = {
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
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
  upload: 'M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  chevron: 'M9 6l6 6-6 6',
  dot: 'M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  warning: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 13l4 4L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  waveform: 'M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2',
  // Three linked points: vectors and their neighbours.
  nodes: 'M6 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0'
    + 'M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 7.3l8-1M7 9l4 7.2M17 8l-4 8.2',
  key: 'M8 15m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M10.9 12.1 20 3M16.5 6.5l2.5 2.5M14 9l2 2',
  globe: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M12.5 14H16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  // Head, antenna, ears and two eyes; the filled variant masks the eyes out.
  robot:
    'M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z'
    + 'M12 8V5M12 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M2 13v2M22 13v2'
    + ROBOT_EYES,
};

/**
 * Shapes punched out of the filled variant. A stroked outline over a cut-out
 * would close a small hole again, and a background-coloured fill guesses the
 * surface behind the icon; a mask removes the pixels on any background.
 */
const CUTOUTS: Partial<Record<IconName, string>> = {
  robot: 'M9 14m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M15 14m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0',
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}

export function Icon({ name, size = 18, className, filled }: IconProps) {
  const maskId = useId();
  const cutout = filled ? CUTOUTS[name] : undefined;
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
      {cutout && (
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" stroke="none" />
          <path d={cutout} fill="black" stroke="none" />
        </mask>
      )}
      <path d={PATHS[name]} mask={cutout ? `url(#${maskId})` : undefined} />
    </svg>
  );
}
