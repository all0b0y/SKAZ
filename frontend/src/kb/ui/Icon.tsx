import type { ComponentType, SVGProps } from 'react';
import {
  ArrowUp, AtSign, AudioWaveform, BookOpenText, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  CircleDot, Command, Download, Ellipsis, ExternalLink, FileMusic, FileText, FileVideoCamera, Folder, FolderPlus,
  Globe, Inbox, Info, Languages, Library, Link, MessagesSquare, Mic, Minimize2, Maximize2, Monitor, Moon,
  PanelLeft, Paperclip, Pencil, Pin, Play, Plus, Quote, RotateCw, Search, Settings, ShieldCheck, Square,
  SquarePen, Sun, Trash2, Pause, LayoutList, LayoutGrid, TriangleAlert, Type, Upload, Waypoints, X, Palette, HardDrive, Sparkles, Bell,
  ArrowUpDown, BookPlus, ChevronUp, Clock, Copy, CornerDownLeft, Eye, FileCheck, KeyRound, Lightbulb, LoaderCircle,
  LogIn, MessageSquare, NotebookText, PinOff, ShieldAlert, Terminal, WandSparkles, ArrowRightToLine,
  CircleCheck, CircleX, CircleSlash, Undo2, PenLine, Star, Eye as EyeOn, EyeOff, SlidersHorizontal,
  Layers, ListChecks, RotateCcw, Flame, CircleQuestionMark, Minus, Scan,
} from 'lucide-react';

/**
 * The one wrapper for interface icons (decision 39): Lucide, stroke 1.25, decorative by default.
 * Names are SKAZ concepts, not Lucide names, so a glyph can change in one place.
 * The 33 concepts follow icons38.py (`lucide = dict(...)`); the rest are shell needs.
 */
const ICONS = {
  // 33 concepts (icons38.py)
  chats: MessagesSquare,
  materials: Library,
  wiki: BookOpenText,
  bell: Bell,
  settings: Settings,
  newChat: SquarePen,
  search: Search,
  mic: Mic,
  upload: Upload,
  attach: Paperclip,
  mention: AtSign,
  send: ArrowUp,
  stop: Square,
  waveform: AudioWaveform,
  quote: Quote,
  link: Link,
  pdf: FileText,
  video: FileVideoCamera,
  audio: FileMusic,
  folder: Folder,
  inbox: Inbox,
  export: Download,
  pencil: Pencil,
  retry: RotateCw,
  sidebar: PanelLeft,
  more: Ellipsis,
  check: Check,
  warning: TriangleAlert,
  close: X,
  agent: Bot,
  translate: Languages,
  graph: Waypoints,
  command: Command,
  // Shell extras
  plus: Plus,
  chevronDown: ChevronDown,
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
  web: Globe,
  text: Type,
  external: ExternalLink,
  trash: Trash2,
  sun: Sun,
  moon: Moon,
  system: Monitor,
  // Package 2 (U2): chat, composer, notifications, settings
  copy: Copy,
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

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export const ICON_STROKE = 1.25;

export interface IconProps {
  name: IconName;
  /** Pixel size (square). Defaults to the 16px token. */
  size?: number;
  /** When set, the icon carries meaning on its own and is announced with this text. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 16, label, className }: IconProps) {
  const Glyph = ICONS[name];
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <Glyph
      size={size}
      strokeWidth={ICON_STROKE}
      className={className ? `kb-icon ${className}` : 'kb-icon'}
      focusable="false"
      data-icon={name}
      {...a11y}
    />
  );
}
