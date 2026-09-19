// Strict media-permission trust decisions, kept pure (no Electron imports) so
// both the request handler and the synchronous check handler can be unit-tested.
//
// Hardens the previous `isTrustedRendererUrl` which trusted a missing URL, any
// file:// URL, and dev-prefix lookalikes. Here the requesting URL/origin must be
// an exact parsed match, the sender must be the main window's webContents, the
// frame must be the main frame, and media must be audio-only (unknown/empty
// media types are denied by default) — while still permitting the real mic.

export interface MediaRequestContext {
  permission: string;
  /** sender webContents === main window's webContents */
  fromTrustedWebContents: boolean;
  requestingUrl: string | undefined;
  mediaTypes: string[] | undefined;
}

export interface MediaCheckContext {
  permission: string;
  fromTrustedWebContents: boolean;
  requestingOrigin: string | undefined;
  isMainFrame: boolean | undefined;
  /** 'audio' | 'video' | 'unknown' | undefined */
  mediaType: string | undefined;
}

function urlMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  if (actual === expected) return true;
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.protocol === e.protocol && a.host === e.host && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

function originMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  if (actual === expected) return true;
  // The file scheme is opaque: `new URL('file:///x').origin` is the string
  // "null", so the parsed comparison below can never match it. Chromium spells
  // the renderer's origin 'file:///' while `expected` is derived as 'file://';
  // treat those as the same origin, and only for the file scheme. Getting this
  // wrong denies every permission CHECK — capture still works (the request
  // handler matches the full URL) but Chromium then hides device labels, so the
  // picker can only show "Microphone 1".
  if (expected === 'file://') return actual === 'file://' || actual === 'file:///';
  try {
    return new URL(actual).origin === expected;
  } catch {
    return false;
  }
}

/**
 * Authoritative grant gate for getUserMedia. Grants only audio-only capture from
 * the exact trusted renderer URL on the main window's webContents.
 */
export function isTrustedMediaRequest(ctx: MediaRequestContext, expectedUrl: string): boolean {
  if (ctx.permission !== 'media') return false;
  if (!ctx.fromTrustedWebContents) return false;
  if (!urlMatches(ctx.requestingUrl, expectedUrl)) return false;
  const types = ctx.mediaTypes;
  if (!types || types.length === 0) return false; // unknown media types → deny by default
  return types.includes('audio') && !types.includes('video');
}

/**
 * Synchronous pre-check (navigator.permissions.query / getUserMedia probe). The
 * authoritative grant is `isTrustedMediaRequest`; here the subtype may be absent
 * on a legitimate probe, so an absent subtype is allowed but an explicit
 * non-audio subtype is denied.
 */
export function isTrustedMediaCheck(ctx: MediaCheckContext, expectedOrigin: string): boolean {
  if (ctx.permission !== 'media') return false;
  if (!ctx.fromTrustedWebContents) return false;
  if (ctx.isMainFrame === false) return false;
  if (!originMatches(ctx.requestingOrigin, expectedOrigin)) return false;
  if (ctx.mediaType !== undefined && ctx.mediaType !== 'audio') return false;
  return true;
}
