// Phase P (0.3.1): agent permission requests and agent questions — routes, parts and helpers over the
// generated /kb types.

import type {
  KbChatEvent, KbChatSummary, KbEndpoints, KbMessagePart, KbPermissionDecide, KbPermissionPart, KbQuestionAnswer, KbQuestionPart,
} from '../../api/kb/types.gen';
import type { KbClient } from './client';

export type {
  KbPermissionChange, KbPermissionPart, KbPermissionSummary, KbQuestionAnswer, KbQuestionOption, KbQuestionPart,
} from '../../api/kb/types.gen';

export type KbPermissionKind = KbPermissionPart['kind'];
export type KbPermissionStatus = KbPermissionPart['status'];
export type KbPermissionDecision = KbPermissionDecide;

/** The three phase-P routes (generated). */
export type KbPermissionEndpoints = Pick<KbEndpoints,
  'POST /kb/permissions/{permission_id}/decide' | 'POST /kb/permissions/{permission_id}/undo' | 'POST /kb/questions/{question_id}/answer'>;

// The generated types now carry the phase-P parts, events and flag; these names stay for readers.
export type AnyMessagePart = KbMessagePart;
export type KbChatEventP = KbChatEvent;
export type KbChatSummaryP = KbChatSummary;

export type PermissionRoute = keyof KbPermissionEndpoints;

export function decidePermission(client: KbClient, id: string, body: KbPermissionDecision): Promise<KbPermissionPart> {
  return client.call('POST /kb/permissions/{permission_id}/decide', { path: { permission_id: id }, body });
}

export function undoPermission(client: KbClient, id: string): Promise<KbPermissionPart> {
  return client.call('POST /kb/permissions/{permission_id}/undo', { path: { permission_id: id } });
}

export function answerQuestion(client: KbClient, id: string, body: KbQuestionAnswer): Promise<KbQuestionPart> {
  return client.call('POST /kb/questions/{question_id}/answer', { path: { question_id: id }, body });
}

export const isPermissionPart = (p: { type: string }): p is KbPermissionPart => p.type === 'permission';
export const isQuestionPart = (p: { type: string }): p is KbQuestionPart => p.type === 'question';

/** The parts of a message, seen with the phase-P part types. */
export const partsOf = (m: { parts: readonly KbMessagePart[] }): readonly AnyMessagePart[] => m.parts;

/** A permission or a question still waits for the user's answer. */
export function isWaitingPart(p: AnyMessagePart): boolean {
  return (p.type === 'permission' || p.type === 'question') && p.status === 'pending';
}

export const isWaitingForUser = (c: KbChatSummary): boolean => c.waiting_for_user === true;
