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
  return `/sessions/${encodeURIComponent(sessionId)}/audio${purpose === 'store' ? '/store' : ''}`;
}

// A JSON body larger than this is almost certainly a bug or abuse; settings
// updates and questions are tiny. Audio never travels through this path.
const MAX_JSON_BODY_CHARS = 64 * 1024;
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
  { method: 'GET', pattern: /^\/settings$/ },
  { method: 'PUT', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/models$/ },
  { method: 'POST', pattern: /^\/models\/local\/prepare$/ },
  { method: 'GET', pattern: /^\/models\/local\/status$/ },
  { method: 'DELETE', pattern: /^\/models\/local$/ },
  { method: 'GET', pattern: /^\/asr\/live\/capabilities$/ },
  { method: 'GET', pattern: /^\/sessions$/ },
  { method: 'POST', pattern: /^\/sessions$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/sessions\/[^/]+$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/audio$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/audio$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/audio\/[^/]+$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/asr\/live$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/asr\/live\/scheduler$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/asr\/live\/advance$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/ask$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/notes$/ },
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
    if (serialized.length > MAX_JSON_BODY_CHARS) {
      return `request body too large (${serialized.length} > ${MAX_JSON_BODY_CHARS} chars)`;
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
