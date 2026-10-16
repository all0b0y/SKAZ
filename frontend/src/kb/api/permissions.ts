// Phase P (0.3.1) contract shapes the generated /kb types don't have yet: agent permission requests,
// agent questions, their routes, `part_update` chat events and `waiting_for_user` on chat summaries.
// Names follow PLAN-0.3.1 «Контракт фазы P» so that, once the backend's types.gen.ts carries them,
// integration is: delete the LOCAL CONTRACT block below, import the same names from types.gen.ts,
// and let `callP` become `client.call` (the route keys are written exactly as the backend serves them).

import type { KbChatEvent, KbChatSummary, KbMessagePart } from '../../api/kb/types.gen';
import type { KbClient } from './client';

// ---- LOCAL CONTRACT (until types.gen.ts is regenerated) ---------------------------------------

export type KbPermissionKind = 'create' | 'edit' | 'rename' | 'delete';
export type KbPermissionStatus = 'pending' | 'allowed' | 'denied' | 'cancelled' | 'undone';

export interface KbPermissionSummary {
  added: number;
  changed: number;
  removed: number;
  user_notes_untouched: boolean;
}

/** One block of the proposed change: `label` is the human block label («From sources»), `block_kind` its kind. */
export interface KbPermissionChange {
  op: 'add' | 'replace' | 'remove';
  block_id: string | null;
  label: string;
  before: string | null;
  after: string | null;
  block_kind: string;
}

export interface KbPermissionPart {
  type: 'permission';
  id: string;
  kind: KbPermissionKind;
  engine: 'codex' | 'claude_code' | 'hermes';
  page_id: string | null;
  title: string;
  status: KbPermissionStatus;
  /** Allowed without a question by an earlier «Allow in this chat». */
  auto: boolean;
  reason: string | null;
  summary: KbPermissionSummary;
  changes: KbPermissionChange[];
}

export interface KbQuestionOption {
  label: string;
  description: string;
  recommended: boolean;
}

export interface KbQuestionPart {
  type: 'question';
  id: string;
  engine: 'codex' | 'claude_code' | 'hermes';
  question: string;
  options: KbQuestionOption[];
  allow_other: boolean;
  status: 'pending' | 'answered' | 'superseded' | 'cancelled';
  answer: string | null;
}

export interface KbPermissionDecision {
  decision: 'allow' | 'allow_chat' | 'deny';
  /** For the agent, ≤ 500 characters. */
  reason?: string | null;
}

export interface KbQuestionAnswer {
  option_index?: number | null;
  text?: string | null;
}

/** The three phase-P routes, in the generated `KbEndpoints` shape. */
export interface KbPermissionEndpoints {
  'POST /kb/permissions/{permission_id}/decide': {
    path: { permission_id: string };
    query: Record<string, never>;
    body: KbPermissionDecision;
    response: KbPermissionPart;
    status: 200;
  };
  'POST /kb/permissions/{permission_id}/undo': {
    path: { permission_id: string };
    query: Record<string, never>;
    body: never;
    response: KbPermissionPart;
    status: 200;
  };
  'POST /kb/questions/{question_id}/answer': {
    path: { question_id: string };
    query: Record<string, never>;
    body: KbQuestionAnswer;
    response: KbQuestionPart;
    status: 200;
  };
}

// ---- Widened views of generated types (collapse to the generated ones after regeneration) -----

/** Any part of a message, the phase-P ones included. */
export type AnyMessagePart = KbMessagePart | KbPermissionPart | KbQuestionPart;

/** A chat event, with the new `part_update` (a full part replacing the part with the same id). */
export type KbChatEventP = Omit<KbChatEvent, 'type' | 'part'> & {
  type: KbChatEvent['type'] | 'part_update';
  part?: AnyMessagePart | null;
};

/** A chat summary with the new flag: a permission or a question waits for the user. */
export type KbChatSummaryP = KbChatSummary & { waiting_for_user?: boolean };

// ---- Helpers --------------------------------------------------------------------------------

export type PermissionRoute = keyof KbPermissionEndpoints;
type PSpec<R extends PermissionRoute> = KbPermissionEndpoints[R];

/** `client.call` for the phase-P routes (same transport, same errors). */
function callP<R extends PermissionRoute>(
  client: KbClient, route: R, options: { path: PSpec<R>['path']; body?: PSpec<R>['body'] },
): Promise<PSpec<R>['response']> {
  const call = client.call.bind(client) as unknown as (r: string, o: typeof options) => Promise<PSpec<R>['response']>;
  return call(route, options);
}

export function decidePermission(client: KbClient, id: string, body: KbPermissionDecision): Promise<KbPermissionPart> {
  return callP(client, 'POST /kb/permissions/{permission_id}/decide', { path: { permission_id: id }, body });
}

export function undoPermission(client: KbClient, id: string): Promise<KbPermissionPart> {
  return callP(client, 'POST /kb/permissions/{permission_id}/undo', { path: { permission_id: id } });
}

export function answerQuestion(client: KbClient, id: string, body: KbQuestionAnswer): Promise<KbQuestionPart> {
  return callP(client, 'POST /kb/questions/{question_id}/answer', { path: { question_id: id }, body });
}

export const isPermissionPart = (p: { type: string }): p is KbPermissionPart => p.type === 'permission';
export const isQuestionPart = (p: { type: string }): p is KbQuestionPart => p.type === 'question';

/** The parts of a message, seen with the phase-P part types. */
export const partsOf = (m: { parts: readonly KbMessagePart[] }): readonly AnyMessagePart[] => m.parts as readonly AnyMessagePart[];

/** A permission or a question still waits for the user's answer. */
export function isWaitingPart(p: AnyMessagePart): boolean {
  return (p.type === 'permission' || p.type === 'question') && p.status === 'pending';
}

export const isWaitingForUser = (c: KbChatSummary): boolean => (c as KbChatSummaryP).waiting_for_user === true;
