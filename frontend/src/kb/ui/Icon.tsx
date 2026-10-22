import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type RefAttributes, type SVGProps } from 'react';
import { useReducedMotion } from 'motion/react';
import type { IconHandle } from '@animateicons/react';
// Per-icon modules, never the barrels: a barrel would pull all 1170 icons into dev and tests.
import { ArrowUpIcon } from '@animateicons/react/lucide/arrow-up-icon';
import { CheckIcon } from '@animateicons/react/lucide/check-icon';
import { SquarePenIcon } from '@animateicons/react/lucide/square-pen-icon';
import { Book01Icon } from '@animateicons/react/huge/book-0-1-icon';
import { Cancel01Icon } from '@animateicons/react/huge/cancel-0-1-icon';
import { ChevronDownIcon } from '@animateicons/react/huge/chevron-down-icon';
import { CopyIcon } from '@animateicons/react/huge/copy-icon';
import { Globe02Icon } from '@animateicons/react/huge/globe-0-2-icon';
import { Message01Icon } from '@animateicons/react/huge/message-0-1-icon';
import { Mic01Icon } from '@animateicons/react/huge/mic-0-1-icon';
import { MoreHorizontalIcon } from '@animateicons/react/huge/more-horizontal-icon';
import { NotificationIcon } from '@animateicons/react/huge/notification-icon';
import { Pen01Icon } from '@animateicons/react/huge/pen-0-1-icon';
import { QuoteIcon } from '@animateicons/react/huge/quote-icon';
import { Refresh01Icon } from '@animateicons/react/huge/refresh-0-1-icon';
import { SearchIcon } from '@animateicons/react/huge/search-icon';
import { Settings01Icon } from '@animateicons/react/huge/settings-0-1-icon';
import { StopIcon } from '@animateicons/react/huge/stop-icon';
import {
  ArrowUp, Check, SquarePen,
  AtSign, AudioWaveform, BookOpenText, Bot, ChevronLeft, ChevronRight, CircleAlert,
  CircleDot, Command, Download, ExternalLink, FileMusic, FileText, FileVideoCamera, Folder, FolderPlus,
  Inbox, Info, Languages, Link, Minimize2, Maximize2, Monitor, Moon,
  PanelLeft, Paperclip, Pin, Play, Plus, ShieldCheck,
  Sun, Trash2, Pause, LayoutList, LayoutGrid, TriangleAlert, Type, Upload, Waypoints, Palette, HardDrive, Sparkles,
  ArrowUpDown, BookPlus, ChevronUp, Clock, CornerDownLeft, Eye, FileCheck, KeyRound, Lightbulb, LoaderCircle,
  LogIn, MessageSquare, NotebookText, PinOff, ShieldAlert, Terminal, WandSparkles, ArrowRightToLine,
  CircleCheck, CircleX, CircleSlash, Undo2, PenLine, Star, Eye as EyeOn, EyeOff, SlidersHorizontal,
  Layers, ListChecks, RotateCcw, Flame, CircleQuestionMark, Minus, Scan,
} from 'lucide-react';

/**
 * The one wrapper for interface icons (decision 39): stroke 1.5, decorative by default.
 * Names are SKAZ concepts, not Lucide names, so a glyph can change in one place.
 * The 33 concepts follow icons38.py (`lucide = dict(...)`); the rest are shell needs.
 *
 * Three sources (animated-icons spec, 2026-10-22), told apart by `data-set` on the icon:
 * - `lucide`: static `lucide-react` glyphs (this table) — nearly every concept;
 * - `huge`: Hugeicons shapes from `@animateicons/react`, shape only (no hover motion);
 * - `lucide-animated`: Lucide shapes from `@animateicons/react` that move as feedback.
 * Licences of `@animateicons/react` and the shapes under it: `frontend/public/licenses/AnimateIcons-MIT.txt`.
 */
const ICONS = {
  // 33 concepts (icons38.py)
  wiki: BookOpenText,
  upload: Upload,
  attach: Paperclip,
  mention: AtSign,
  waveform: AudioWaveform,
  link: Link,
  pdf: FileText,
  video: FileVideoCamera,
  audio: FileMusic,
  folder: Folder,
  inbox: Inbox,
  export: Download,
  sidebar: PanelLeft,
  warning: TriangleAlert,
  agent: Bot,
  translate: Languages,
  graph: Waypoints,
  command: Command,
  // Shell extras
  plus: Plus,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  expand: Maximize2,
  // Chat actions v1 (2026-10-21): the diagram viewer's zoom out and Fit.
  minus: Minus,
  fit: Scan,
  collapse: Minimize2,
  play: Play,
  concept: CircleDot,
  pin: Pin,
  folderPlus: FolderPlus,
  storage: HardDrive,
  privacy: ShieldCheck,
  appearance: Palette,
  about: Info,
  models: Sparkles,
  error: CircleAlert,
  text: Type,
  external: ExternalLink,
  trash: Trash2,
  sun: Sun,
  moon: Moon,
  system: Monitor,
  // Package 2 (U2): chat, composer, notifications, settings
  saveWiki: BookPlus,
  answering: LoaderCircle,
  clock: Clock,
  analysis: Lightbulb,
  note: NotebookText,
  key: KeyRound,
  signIn: LogIn,
  terminal: Terminal,
  askAgent: MessageSquare,
  unpin: PinOff,
  chevronUp: ChevronUp,
  enter: CornerDownLeft,
  arrows: ArrowUpDown,
  tab: ArrowRightToLine,
  tool: Eye,
  ready: FileCheck,
  fixes: WandSparkles,
  shield: ShieldAlert,
  // Package 2 (U3): recording, all materials
  pause: Pause,
  table: LayoutList,
  cards: LayoutGrid,
  // 0.3.1 P: agent permission requests and questions
  permission: ShieldCheck,
  allowed: CircleCheck,
  denied: CircleX,
  cancelled: CircleSlash,
  undo: Undo2,
  // 0.3.1 H: Settings → Skills
  skills: PenLine,
  // 0.3.1 K: favourites and visibility of models
  star: Star,
  shown: EyeOn,
  hidden: EyeOff,
  editModels: SlidersHorizontal,
  // 0.3.1 S: flashcards and tests
  deck: Layers,
  test: ListChecks,
  flip: RotateCcw,
  hard: Flame,
  /** "What these labels mean" (wiki terms in Settings → Wiki). */
  help: CircleQuestionMark,
} satisfies Record<string, ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>>;

/** What `@animateicons/react` icons take that we use. Their root is a div: attributes land on it, not on the svg. */
type LibraryIcon = ComponentType<RefAttributes<IconHandle> & {
  size?: number;
  isAnimated?: boolean;
  className?: string;
  role?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
}>;

/** Hugeicons shapes (spec §3): drawn the same box as Lucide, never animated on hover. */
const HUGE = {
  chats: Message01Icon,
  materials: Book01Icon,
  bell: NotificationIcon,
  copy: CopyIcon,
  retry: Refresh01Icon,
  close: Cancel01Icon,
  web: Globe02Icon,
  quote: QuoteIcon,
  mic: Mic01Icon,
  settings: Settings01Icon,
  search: SearchIcon,
  more: MoreHorizontalIcon,
  pencil: Pen01Icon,
  chevronDown: ChevronDownIcon,
  stop: StopIcon,
} satisfies Record<string, LibraryIcon>;

/** Lucide shapes that move as feedback (spec §3): the ↑ of Send, the pen of New chat, the ✓ after Copy. */
const LUCIDE_ANIMATED = {
  send: ArrowUpIcon,
  newChat: SquarePenIcon,
  check: CheckIcon,
} satisfies Record<string, LibraryIcon>;

/**
 * The same Lucide shapes, static, for every place that never plays them (no `play` prop): the library's root is a
 * `<div>`, which must not land inside a `<p>` (a ✓ in a status line, a banner) — the static `<svg>` can.
 */
const LUCIDE_STILL = { send: ArrowUp, newChat: SquarePen, check: Check } satisfies Record<keyof typeof LUCIDE_ANIMATED, unknown>;

export type IconName = keyof typeof ICONS | keyof typeof HUGE | keyof typeof LUCIDE_ANIMATED;
export const ICON_NAMES = [
  ...Object.keys(ICONS), ...Object.keys(HUGE), ...Object.keys(LUCIDE_ANIMATED),
] as IconName[];

/** Where a concept's glyph comes from; also the value of `data-set`. */
export type IconSet = 'lucide' | 'huge' | 'lucide-animated';

/**
 * Stroke of every icon. The library hard-codes `stroke-width="2"` on its svg, so `ui.css` sets the
 * same value for `.kb-icon svg` — keep the two in step (a test reads the CSS).
 */
export const ICON_STROKE = 1.5;

export interface IconProps {
  name: IconName;
  /** Pixel size (square). Defaults to the 16px token. */
  size?: number;
  /** When set, the icon carries meaning on its own and is announced with this text. */
  label?: string;
  className?: string;
  /**
   * Feedback counter: every change plays the icon's motion once (never on hover; nothing under reduced
   * motion). Only Huge/animated Lucide shapes move; the first value an icon is mounted with is not a change.
   * Raise it where the action happens (`setPlay((n) => n + 1)`).
   */
  play?: number;
}

function a11yOf(label: string | undefined) {
  return label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
}

/** An animated-icons glyph: all motion comes from `handle`, so its own hover handler stays off. */
function LibraryGlyph({ name, Glyph, set, size, label, className, play }: {
  name: IconName; Glyph: LibraryIcon; set: Exclude<IconSet, 'lucide'>; size: number; label?: string; className?: string; play?: number;
}) {
  const reduced = useReducedMotion() ?? false;
  const handle = useRef<IconHandle | null>(null);
  const seen = useRef(play);
  // Layout effect: the motion starts before the first paint, so a ✓ that just appeared is not seen whole first.
  useLayoutEffect(() => {
    if (play === seen.current) return;
    seen.current = play;
    if (!play || reduced) return;
    // Back to rest first, so a second click while it still moves plays from the start.
    handle.current?.stopAnimation();
    handle.current?.startAnimation();
  }, [play, reduced]);
  // The ref is what keeps the library from starting on hover (its handler then calls ours — there is none);
  // `isAnimated={false}` is the second lock.
  return (
    <Glyph
      ref={handle}
      size={size}
      isAnimated={false}
      className={className ? `kb-icon kb-icon--lib ${className}` : 'kb-icon kb-icon--lib'}
      {...({ focusable: 'false' } as object)}
      data-icon={name}
      data-set={set}
      {...a11yOf(label)}
    />
  );
}

export function Icon({ name, size = 16, label, className, play }: IconProps) {
  if (name in HUGE) {
    return <LibraryGlyph name={name} Glyph={HUGE[name as keyof typeof HUGE]} set="huge" size={size} label={label} className={className} play={play} />;
  }
  if (name in LUCIDE_ANIMATED && play !== undefined) {
    return <LibraryGlyph name={name} Glyph={LUCIDE_ANIMATED[name as keyof typeof LUCIDE_ANIMATED]} set="lucide-animated" size={size} label={label} className={className} play={play} />;
  }
  const still = name in LUCIDE_STILL;
  const Glyph = still ? LUCIDE_STILL[name as keyof typeof LUCIDE_STILL] : ICONS[name as keyof typeof ICONS];
  return (
    <Glyph
      size={size}
      strokeWidth={ICON_STROKE}
      className={className ? `kb-icon ${className}` : 'kb-icon'}
      focusable="false"
      data-icon={name}
      data-set={still ? 'lucide-animated' : 'lucide'}
      {...a11yOf(label)}
    />
  );
}

/** How long a feedback motion runs (the longest of the six is about 0.6 s). */
export const ICON_PLAY_MS = 600;

/** A feedback counter for {@link IconProps.play}: `[play, replay]` — call `replay()` where the action happens. */
export function useIconPlay(): [number, () => void] {
  const [play, setPlay] = useState(0);
  return [play, useCallback(() => setPlay((n) => n + 1), [])];
}

/**
 * {@link useIconPlay} for an icon that something else replaces right after the action (a busy spinner):
 * `held` is true for {@link ICON_PLAY_MS} after `replay()`, so the caller can keep the icon in place while it moves.
 * Never held under reduced motion — nothing moves then, so nothing waits.
 */
export function useIconPlayHold(): { play: number; held: boolean; replay: () => void } {
  const reduced = useReducedMotion() ?? false;
  const [play, replayIcon] = useIconPlay();
  const [held, setHeld] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const replay = useCallback(() => {
    replayIcon();
    if (reduced) return;
    setHeld(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHeld(false), ICON_PLAY_MS);
  }, [replayIcon, reduced]);
  return { play, held, replay };
}
