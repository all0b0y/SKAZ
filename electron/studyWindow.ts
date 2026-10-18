// 0.3.1 S (W2): a deck or test block in a small window of its own, the same chat below it. Pure
// (no Electron imports) so the trust rules are unit-tested; main.ts owns the window itself.
//
// The window loads the same renderer with `#study=<block id>&chat=<chat id>`. It is trusted for
// one thing only: backend requests through the same /kb allowlist as the main window (ipc.ts). It
// can close itself; only the main window can open one, and there is one at a time (A-4).

import type { StudyWindowTarget } from '../frontend/src/api/bridge';

/** Ids as the backend makes them: a study block is `st-<hex>`, a chat one path-safe segment. */
const STUDY_ID = /^st-[A-Za-z0-9_-]{1,64}$/;
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A clean target from a renderer payload, or null when it isn't one. */
export function validateStudyTarget(payload: unknown): StudyWindowTarget | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as { studyId?: unknown; chatId?: unknown };
  if (typeof raw.studyId !== 'string' || !STUDY_ID.test(raw.studyId)) return null;
  if (typeof raw.chatId !== 'string' || !CHAT_ID.test(raw.chatId)) return null;
  return { studyId: raw.studyId, chatId: raw.chatId };
}

/** The URL fragment of the block's window (no leading `#`). */
export function studyHash(target: StudyWindowTarget): string {
  return `study=${target.studyId}&chat=${target.chatId}`;
}

/** The target of a window from its URL fragment, checked like a payload. */
export function parseStudyHash(hash: string): StudyWindowTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return validateStudyTarget({ studyId: params.get('study') ?? undefined, chatId: params.get('chat') ?? undefined });
}

export const sameTarget = (a: StudyWindowTarget | null, b: StudyWindowTarget | null): boolean =>
  !!a && !!b && a.studyId === b.studyId && a.chatId === b.chatId;
