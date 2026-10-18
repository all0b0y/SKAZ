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
  // Legacy routes the Knowledge Wiki recorder still uses: recording options, the sample clock of
  // the recording's technical session, and its status fallback (audio/nativeWriter.ts). The live
  // text itself comes from GET /kb/recordings/{id}/live.
  { method: 'GET', pattern: /^\/settings$/ },
  { method: 'PUT', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/sessions\/[^/]+\/live$/ },
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
  { method: 'GET', pattern: /^\/kb\/settings\/(?:health|keys|speech|privacy|about|wiki|recognition)$/ },
  { method: 'PUT', pattern: /^\/kb\/settings\/(?:speech|wiki|recognition)$/ },
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
  // H2: queue every material whose wiki job failed or was interrupted again, in one click.
  { method: 'POST', pattern: /^\/kb\/jobs\/retry-failed$/ },
  { method: 'POST', pattern: /^\/kb\/imports$/ },
  // QA E10: a failed or interrupted import says why on its material and starts again from there.
  { method: 'POST', pattern: /^\/kb\/imports\/[^/]+\/(?:retry|cancel)$/ },
  { method: 'POST', pattern: /^\/kb\/links\/classify$/ },
  // U3 (package 2): wiki page list and block edits, rename/move/delete with preview, all recognition
  // fixes, jobs, graph, recordings. Shared routes are listed once, in the U2 block above.
  { method: 'GET', pattern: /^\/kb\/wiki\/pages$/ },
  { method: 'POST', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks$/ },
  { method: 'PUT', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+$/ },
  { method: 'POST', pattern: /^\/kb\/wiki\/pages\/[^/]+\/blocks\/[^/]+\/recheck$/ },
  // B20: rename and delete a page (with its preview); its file path stays main-only.
  { method: 'PATCH', pattern: /^\/kb\/wiki\/pages\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/kb\/wiki\/pages\/[^/]+$/ },
  { method: 'GET', pattern: /^\/kb\/wiki\/pages\/[^/]+\/delete-preview$/ },
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
  // G: the live panel's text after the material (open monologue + words still being recognised).
  { method: 'GET', pattern: /^\/kb\/recordings\/[^/]+\/live$/ },
  // F2: sign out of SKAZ's own Codex profile; delete the downloaded Whisper model (after a confirmation).
  { method: 'POST', pattern: /^\/kb\/agents\/codex\/logout$/ },
  { method: 'DELETE', pattern: /^\/kb\/settings\/speech\/local-model$/ },
  // B20: "Check recognition again" of a recording (a backend job on the chosen agent).
  { method: 'POST', pattern: /^\/kb\/materials\/[^/]+\/recognition-check$/ },
  // B20: export into a folder from the native chooser (the backend refuses one inside the library,
  // and a non-empty one without the user's confirmation; development runs keep to their Documents).
  { method: 'GET', pattern: /^\/kb\/export\/target$/ },
  // B20: Wiki/index.md and Wiki/log.md, read-only in the right panel.
  { method: 'GET', pattern: /^\/kb\/wiki\/files\/(?:index|log)$/ },
  { method: 'POST', pattern: /^\/kb\/export$/ },
];

/**
 * The legacy `PUT /settings` takes every app setting, consent and provider choice included. The
 * renderer only sets the recording options (kb/recording/recordingStore.ts `setOptions`); consent,
 * keys and providers have their own routes and dialogs. Anything else in the body is refused here,
 * in the main process (final review M5).
 */
export const RENDERER_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  'native_recording_mode', 'translation_target_language', 'input_device_id', 'capture_system_audio',
]);

function settingsBodyError(body: unknown): string | null {
  if (body === undefined) return null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'settings body must be an object';
  const refused = Object.keys(body).filter((key) => !RENDERER_SETTINGS_FIELDS.has(key));
  return refused.length ? `settings field not allowed from the window: ${refused.join(', ')}` : null;
}

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
  // Reject traversal in raw and percent-encoded forms, plus backslashes. An encoded slash would be
  // decoded by the backend into another route (`/kb/materials/%2F` answered with the list — QA E3).
  if (path.includes('..') || /%2e|%2f|%5c/i.test(path) || path.includes('\\')) {
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
  if (req.method === 'PUT' && req.path === '/settings') return settingsBodyError(req.body);
  return null;
}
