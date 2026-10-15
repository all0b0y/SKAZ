// Pure IPC boundary policy shared by the main-process handlers. Kept free of any
// Electron imports so it can be unit-tested deterministically and reused from
// both main.ts (window-open guard) and ipc.ts (request/upload validation).
//
// Enforces:
//  - external links may only open with http/https, never file:/javascript:/custom schemes;
//  - the renderer may only reach the listed method+path pairs, with no path
//    traversal or absolute URLs smuggled through the `path` field;
//  - JSON request bodies are bounded before they are proxied to the backend.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BridgeRequestShape {
  method: HttpMethod | string;
  path: string;
  body?: unknown;
}

// A JSON body larger than this is almost certainly a bug or abuse; settings
// updates and questions are tiny. Audio never travels through this path.
const MAX_JSON_BODY_CHARS = 64 * 1024;
/** Every bridge request is answered or abandoned within this time. */
export const REQUEST_TIMEOUT_MS = 120_000;

interface Route {
  method: HttpMethod;
  pattern: RegExp;
}

// What the renderer (frontend/src/kb) calls. `[^/]+` is a single id/sequence segment.
const ROUTES: readonly Route[] = [
  // Legacy routes the Knowledge Wiki recorder still uses: recording options, the live transcript
  // of the recording's technical session, and its status fallback (audio/nativeWriter.ts).
  { method: 'GET', pattern: /^\/settings$/ },
  { method: 'PUT', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live\/events$/ },
  { method: 'PATCH', pattern: /^\/sessions\/[^/]+$/ },
  // Settings → Privacy → Activity log (F2): the technical activity log, read-only, no text or keys.
  { method: 'GET', pattern: /^\/logs$/ },
  // Knowledge library (new interface, frontend/src/kb). Only what the renderer uses: library
  // place, folders (create / rename / delete empty), material list + one material, notification
  // count. Ids are one path segment; nothing here reaches a file path chosen by the renderer
  // except POST /kb/library. That path is the folder the user picked in the native chooser and
  // may be anywhere by design: the packaged app sets no documents sandbox
  // (SKAZ_DOCUMENTS_SANDBOX=''), only development and smoke runs confine it to their own
  // Documents folder (electron/backend.ts, knowledge/service.py `_inside_sandbox`).
  { method: 'GET', pattern: /^\/kb\/library$/ },
  { method: 'POST', pattern: /^\/kb\/library$/ },
  { method: 'POST', pattern: /^\/kb\/library\/retry$/ },
  { method: 'GET', pattern: /^\/kb\/folders$/ },
  { method: 'POST', pattern: /^\/kb\/folders$/ },
  { method: 'PATCH', pattern: /^\/kb\/folders\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/folders\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/materials$/ },
  { method: 'GET', pattern: /^\/kb\/materials\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/notifications$/ },
  // Package 2, U2 (chat, composer, ⌘K, notifications, settings, first launch). Ids are one segment;
  // engines and key providers are fixed lists. No route here takes a file path except the composer's
  // "+" (POST /kb/materials/file, /kb/imports), whose path comes from the native chooser and is
  // confined by the backend like every other material file.
  { method: 'GET', pattern: /^\/kb\/chats$/ },
  { method: 'POST', pattern: /^\/kb\/chats$/ },
  { method: 'GET', pattern: /^\/kb\/chats\/events$/ },
  { method: 'GET', pattern: /^\/kb\/chats\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/kb\/chats\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/chats\/[^/]+$/ },
  { method: 'POST', pattern: /^\/kb\/chats\/[^/]+\/messages$/ },
  { method: 'GET', pattern: /^\/kb\/chats\/[^/]+\/events$/ },
  { method: 'POST', pattern: /^\/kb\/chats\/[^/]+\/messages\/[^/]+\/(?:stop|regenerate|resume|save)$/ },
  { method: 'POST', pattern: /^\/kb\/chats\/[^/]+\/(?:save|read)$/ },
  { method: 'GET', pattern: /^\/kb\/chats\/[^/]+\/export$/ },
  { method: 'GET', pattern: /^\/kb\/mentions$/ },
  { method: 'POST', pattern: /^\/kb\/notifications\/[^/]+\/(?:resolve|dismiss)$/ },
  { method: 'POST', pattern: /^\/kb\/notifications\/read$/ },
  { method: 'GET', pattern: /^\/kb\/materials\/[^/]+\/corrections$/ },
  { method: 'GET', pattern: /^\/kb\/materials\/[^/]+\/excluded$/ },
  { method: 'POST', pattern: /^\/kb\/materials\/[^/]+\/excluded\/\d+\/restore$/ },
  { method: 'GET', pattern: /^\/kb\/search$/ },
  { method: 'GET', pattern: /^\/kb\/wiki\/pages\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/settings\/(?:health|keys|speech|privacy|about|wiki)$/ },
  { method: 'PUT', pattern: /^\/kb\/settings\/(?:speech|wiki)$/ },
  { method: 'POST', pattern: /^\/kb\/settings\/health\/[^/]+\/[^/]+$/ },
  { method: 'PUT', pattern: /^\/kb\/settings\/keys\/(?:openrouter|soniox|openai)$/ },
  { method: 'POST', pattern: /^\/kb\/settings\/keys\/(?:openrouter|soniox|openai)\/check$/ },
  { method: 'POST', pattern: /^\/kb\/wiki\/connections\/find$/ },
  { method: 'GET', pattern: /^\/kb\/agents$/ },
  { method: 'PUT', pattern: /^\/kb\/agents\/default$/ },
  { method: 'POST', pattern: /^\/kb\/agents\/(?:codex|claude_code|hermes)\/(?:check|install|login)$/ },
  { method: 'GET', pattern: /^\/kb\/agents\/install\/[^/]+$/ },
  { method: 'POST', pattern: /^\/kb\/agents\/install\/[^/]+\/cancel$/ },
  { method: 'GET', pattern: /^\/kb\/decisions$/ },
  { method: 'PUT', pattern: /^\/kb\/decisions\/provider$/ },
  { method: 'POST', pattern: /^\/kb\/decisions\/local\/(?:download|cancel)$/ },
  { method: 'POST', pattern: /^\/kb\/materials\/(?:file|link|text)$/ },
  { method: 'POST', pattern: /^\/kb\/materials\/[^/]+\/ingest$/ },
  { method: 'POST', pattern: /^\/kb\/imports$/ },
  { method: 'POST', pattern: /^\/kb\/links\/classify$/ },
  // U3 (package 2): wiki page list and block edits, rename/move/delete with preview, all recognition
  // fixes, jobs, graph, recordings. Shared routes are listed once, in the U2 block above.
  { method: 'GET', pattern: /^\/kb\/wiki\/pages$/ },
  { method: 'POST', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks$/ },
  { method: 'PUT', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+$/ },
  { method: 'POST', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+\/recheck$/ },
  { method: 'PATCH', pattern: /^\/kb\/materials\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/materials\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/materials\/[^/]+\/delete-preview$/ },
  { method: 'POST', pattern: /^\/kb\/corrections\/[^/]+\/(?:revert|accept|keep|reapply)$/ },
  { method: 'GET', pattern: /^\/kb\/jobs$/ },
  { method: 'GET', pattern: /^\/kb\/jobs\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/graph$/ },
  { method: 'GET', pattern: /^\/kb\/recordings\/defaults$/ },
  { method: 'POST', pattern: /^\/kb\/recordings$/ },
  { method: 'POST', pattern: /^\/kb\/recordings\/[^/]+\/(?:stop|pause|resume)$/ },
  // F2: a recording's own state, so its material offers "Continue recording" only when it may continue.
  { method: 'GET', pattern: /^\/kb\/recordings\/[^/]+$/ },
  // F2: sign out of SKAZ's own Codex profile; delete the downloaded Whisper model (after a confirmation).
  { method: 'POST', pattern: /^\/kb\/agents\/codex\/logout$/ },
  { method: 'DELETE', pattern: /^\/kb\/settings\/speech\/local-model$/ },
];

/** The knowledge-library (/kb) rules, for the test that checks them against the backend's routes. */
export function kbRouteRules(): ReadonlyArray<{ method: HttpMethod; pattern: RegExp }> {
  return ROUTES.filter((r) => r.pattern.source.startsWith('^\\/kb\\/'));
}

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
    // Pasted materials have no product length cap. Chat accepts 100,000 characters;
    // JSON may escape each of them to six characters. Keep other routes bounded.
    const maxChars = req.method === 'POST' && req.path === '/kb/materials/text'
      ? Infinity
      : req.method === 'POST' && /^\/kb\/chats\/[^/]+\/messages$/.test(req.path)
        ? 1_000_000
        : MAX_JSON_BODY_CHARS;
    if (serialized.length > maxChars) {
      return `request body too large (${serialized.length} > ${maxChars} chars)`;
    }
  }
  return null;
}
