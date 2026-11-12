// EX3 (UX-1a): the reader of Explore — a paper's own page shown inside SKAZ, in a sandboxed view of its own.
// Pure rules (no Electron imports) so they are unit-tested; paperViewRuntime.ts applies them.
//
//  - Only http/https pages open in it; nothing local or custom-scheme, no credentials in the URL.
//  - It lives in its own persistent partition: a site login (a publisher, a university proxy) is remembered,
//    and it never shares cookies, storage or permissions with SKAZ's own window.
//  - Every permission is denied except copying selected text and video full screen.
//  - Nothing is downloaded from it: a paper reaches SKAZ only through «Add to materials» (UX-7).

/** The reader's own session; `persist:` keeps site logins between launches. */
export const PAPER_PARTITION = 'persist:skaz-papers';

const MAX_URL_CHARS = 4096;

export interface PaperRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaperViewState {
  /** The page shown (after redirects), or null when the reader is empty. */
  url: string | null;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** A page that failed to load: a short reason the slot shows with «Open in browser». */
  error: string | null;
}

export type PaperNavigation = 'back' | 'forward' | 'reload' | 'external';

export const EMPTY_PAPER_STATE: PaperViewState = {
  url: null,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
};

/** The URL to open, normalised, or null when it must not open in the reader. */
export function validatePaperUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

/**
 * The slot the page reserved for the reader, in its CSS pixels, turned into window pixels and kept inside
 * the window. Null for anything that is not four finite numbers.
 */
export function validatePaperBounds(
  raw: unknown,
  window: { width: number; height: number },
  zoom = 1,
): PaperRect | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return null;
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.round(r.x * factor);
  const y = Math.round(r.y * factor);
  const width = Math.round(r.width * factor);
  const height = Math.round(r.height * factor);
  const left = Math.min(Math.max(x, 0), window.width);
  const top = Math.min(Math.max(y, 0), window.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.min(width - (left - x), window.width - left)),
    height: Math.max(0, Math.min(height - (top - y), window.height - top)),
  };
}

export function isPaperNavigation(raw: unknown): raw is PaperNavigation {
  return raw === 'back' || raw === 'forward' || raw === 'reload' || raw === 'external';
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function paperPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

/** A link the page opens in a new window: an http(s) page replaces the reader's page, the rest is refused. */
export function paperPopupTarget(raw: string): string | null {
  return validatePaperUrl(raw);
}

/** Chromium's «navigation aborted» (a new load replaced the old one) is not a failure worth showing. */
export function paperLoadError(code: number, description: string): string | null {
  if (code === -3) return null;
  return description || `Error ${code}`;
}
