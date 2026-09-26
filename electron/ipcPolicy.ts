// Pure IPC boundary policy shared by the main-process handlers. Kept free of any
// Electron imports so it can be unit-tested deterministically and reused from
// both main.ts (window-open guard) and ipc.ts (request/upload validation).
//
// Enforces (see docs/DESKTOP-REVIEW-NOTES.md and docs/API.md):
//  - external links may only open with http/https, never file:/javascript:/custom schemes;
//  - the renderer may only reach the documented method+path pairs, with no path
//    traversal or absolute URLs smuggled through the `path` field;
//  - JSON request bodies and audio-upload metadata/bytes are bounded before they
//    are proxied to the backend.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BridgeRequestShape {
  method: HttpMethod | string;
  path: string;
  body?: unknown;
}

export interface AudioUploadMetaShape {
  sequence: number;
  startMs: number;
  endMs: number;
}

export type AudioUploadPurpose = 'transcribe' | 'store';

/** Exact backend target for the two binary-only audio channels. */
export function audioUploadPath(sessionId: string, purpose: AudioUploadPurpose): string {
  return `/sessions/${encodeURIComponent(sessionId)}/audio${purpose === 'store' ? '/buffer' : ''}`;
}

// A JSON body larger than this is almost certainly a bug or abuse; settings
// updates and questions are tiny. Audio never travels through this path.
const MAX_JSON_BODY_CHARS = 64 * 1024;
// Editable Notes allow 200k characters; leave room for JSON escaping and metadata.
const MAX_NOTE_BODY_CHARS = 1_300_000;

/** Synchronous API Notes can need many provider responses. Codex admission stays fast. */
export function requestTimeoutMs(req: BridgeRequestShape): number {
  const noteGeneration = req.method === 'POST' &&
    /^\/sessions\/[^/]+\/notes(?:\/[^/]+\/rewrite)?$/.test(req.path);
  return noteGeneration ? 3_600_000 : 120_000;
}
// Windows are capped at 30s of PCM16 mono; even at 48kHz that is < 3MB. Leave
// generous headroom for the WAV header and higher sample rates.
const MAX_WAV_BYTES = 8 * 1024 * 1024;
const MAX_DURATION_MS = 30_000;
const MAX_SEQUENCE = 1_000_000;

interface Route {
  method: HttpMethod;
  pattern: RegExp;
}

// Mirrors docs/API.md, plus the two UI-facing local-model status/preparation
// routes documented in .runtime/asr-local-contract.md. `[^/]+` is a single
// id/sequence segment.
const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/web-search\/settings$/ },
  { method: 'PUT', pattern: /^\/web-search\/settings$/ },
  { method: 'GET', pattern: /^\/web-search\/pending$/ },
  { method: 'POST', pattern: /^\/web-search\/requests\/[^/]+\/decision$/ },
  { method: 'GET', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/storage\/root$/ },
  { method: 'GET', pattern: /^\/storage\/layout$/ },
  { method: 'POST', pattern: /^\/storage\/layout$/ },
  { method: 'POST', pattern: /^\/storage\/recover$/ },
  { method: 'POST', pattern: /^\/storage\/move-root$/ },
  { method: 'PUT', pattern: /^\/storage\/groups$/ },
  { method: 'PUT', pattern: /^\/storage\/root$/ },
  { method: 'PUT', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/models$/ },
  { method: 'POST', pattern: /^\/models\/local\/prepare$/ },
  { method: 'GET', pattern: /^\/models\/local\/status$/ },
  { method: 'DELETE', pattern: /^\/models\/local$/ },
  { method: 'GET', pattern: /^\/asr\/live\/capabilities$/ },
  { method: 'GET', pattern: /^\/imports$/ },
  { method: 'POST', pattern: /^\/imports$/ },
  { method: 'GET', pattern: /^\/imports\/active$/ },
  { method: 'GET', pattern: /^\/imports\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/imports\/[^/]+$/ },
  { method: 'POST', pattern: /^\/imports\/[^/]+\/cancel$/ },
  { method: 'POST', pattern: /^\/imports\/[^/]+\/retry$/ },
  { method: 'GET', pattern: /^\/sessions$/ },
  { method: 'POST', pattern: /^\/sessions$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'POST', pattern: /^\/sessions\/delete$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/audio$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live\/events$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/files$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/files$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/files\/preserve$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/asr\/live$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/asr\/live\/scheduler$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/asr\/live\/advance$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/asr\/fragments$/ },
  { method: 'PUT', pattern: /^\/sessions\/[^/]+\/asr\/fragments\/[^/]+\/text$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/asr\/fragments\/[^/]+\/accept$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/ask$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/notes$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/notes\/empty$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/notes$/ },
  { method: 'PATCH', pattern: /^\/sessions\/[^/]+\/notes\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/sessions\/[^/]+\/notes\/[^/]+$/ },
  // Codex Assistant / Notes (.dev/docs/CODEX-UI-CONTRACT.md). No route here can
  // reach a shell, a file or a credential: login returns only an https URL.
  { method: 'GET', pattern: /^\/codex\/state$/ },
  { method: 'POST', pattern: /^\/codex\/chats$/ },
  { method: 'GET', pattern: /^\/codex\/chats\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/codex\/chats\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/codex\/chats\/[^/]+$/ },
  { method: 'POST', pattern: /^\/codex\/chats\/[^/]+\/messages$/ },
  { method: 'POST', pattern: /^\/codex\/tasks\/[^/]+\/stop$/ },
  { method: 'POST', pattern: /^\/codex\/tasks\/[^/]+\/resume$/ },
  { method: 'POST', pattern: /^\/codex\/sessions\/[^/]+\/notes$/ },
  { method: 'PUT', pattern: /^\/codex\/settings$/ },
  { method: 'POST', pattern: /^\/codex\/connection\/check$/ },
  { method: 'POST', pattern: /^\/codex\/connection\/login$/ },
  { method: 'POST', pattern: /^\/codex\/connection\/logout$/ },
  { method: 'GET', pattern: /^\/codex\/previews$/ },
  { method: 'POST', pattern: /^\/codex\/previews\/[^/]+\/apply$/ },
  { method: 'POST', pattern: /^\/codex\/previews\/[^/]+\/discard$/ },
];

/** True only for links safe to hand to the OS browser via shell.openExternal. */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function hasControlChar(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (path.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function validatePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'invalid path';
  if (!path.startsWith('/')) return 'path must start with "/" (absolute URLs are rejected)';
  // Reject traversal in raw and percent-encoded forms, plus backslashes.
  if (path.includes('..') || /%2e/i.test(path) || path.includes('\\')) {
    return 'path contains traversal or unsafe characters';
  }
  if (hasControlChar(path)) return 'path contains control characters';
  return null;
}

/**
 * Validate a JSON bridge request before it is proxied. Returns an error string
 * when the request must be rejected, or null when it is allowed.
 */
export function validateBridgeRequest(req: BridgeRequestShape): string | null {
  const pathError = validatePath(req.path);
  if (pathError) return pathError;

  const allowed = ROUTES.some((r) => r.method === req.method && r.pattern.test(req.path));
  if (!allowed) return `method/path not allowed: ${req.method} ${req.path}`;

  if (req.body !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(req.body);
    } catch {
      return 'request body is not JSON-serializable';
    }
    const limit = req.method === 'PATCH' && /^\/sessions\/[^/]+\/notes\/[^/]+$/.test(req.path)
      ? MAX_NOTE_BODY_CHARS : MAX_JSON_BODY_CHARS;
    if (serialized.length > limit) {
      return `request body too large (${serialized.length} > ${limit} chars)`;
    }
  }
  return null;
}

/**
 * Validate an audio upload's session id, window metadata, and body size before
 * it is proxied. Returns an error string on rejection, or null when allowed.
 */
export function validateAudioUpload(
  sessionId: string,
  meta: AudioUploadMetaShape,
  body: ArrayBuffer,
): string | null {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    /[/\\]/.test(sessionId) ||
    sessionId.includes('..')
  ) {
    return 'invalid session id';
  }
  if (!Number.isInteger(meta.sequence) || meta.sequence < 0 || meta.sequence > MAX_SEQUENCE) {
    return 'invalid sequence';
  }
  if (
    !Number.isInteger(meta.startMs) ||
    !Number.isInteger(meta.endMs) ||
    meta.startMs < 0 ||
    meta.endMs < 0 ||
    meta.endMs <= meta.startMs
  ) {
    return 'invalid time range';
  }
  if (meta.endMs - meta.startMs > MAX_DURATION_MS) {
    return `audio window duration exceeds ${MAX_DURATION_MS}ms limit`;
  }
  if (!(body instanceof ArrayBuffer) || body.byteLength === 0 || body.byteLength > MAX_WAV_BYTES) {
    return 'invalid audio body size';
  }
  return null;
}

/** A shared note is text the user already sees; this only bounds its size. */
const MAX_SHARE_CHARS = 2 * 1024 * 1024;
const MAX_SHARE_NAME = 120;

export interface ShareNoteShape {
  fileName: string;
  content: string;
}

/**
 * The renderer names the shared file, so the name is untrusted input for a path
 * built in main. Only a bare file name is accepted — no directory parts, no
 * traversal, no control characters — and `.md` is appended here, never taken
 * from the renderer, so a note cannot be shared as an executable or a folder.
 * Returns the safe file name, or null when the request must be refused.
 */
export function shareFileName(req: ShareNoteShape): string | null {
  if (typeof req?.fileName !== 'string' || typeof req.content !== 'string') return null;
  if (req.content.length > MAX_SHARE_CHARS) return null;
  let base = req.fileName.replace(/[/\\:]/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (hasControlChar(base) || /[\u007f]/.test(base)) return null;
  while (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3).trim();
  base = base.replace(/^\.+/, '').replace(/[ .]+$/, '').slice(0, MAX_SHARE_NAME).trim();
  if (!base) return null;
  return `${base}.md`;
}
