// Shared navigator of the right document panel (U3). Anything that links to a wiki page or a
// material — a citation chip, a search result, a notification, a graph node — calls
// `openDocument({type, id, block_id?, seg?, quote?})` on the UI store:
//   - type "page": opens the wiki page; `block_id` scrolls to and briefly marks that block;
//   - type "material": opens the material; `seg` scrolls to that fragment, `quote` highlights
//     exactly that checked quote inside it (KbCitation.quote), not the whole fragment.
// Opening the same target again re-runs the scroll/highlight (a new `nonce`).
// The right panel also hosts the graph and the live recording; "All chats" and "All materials"
// take the centre instead of the chat. U2's helpers (`citationRef`, `pageRef`, `subjectRef`,
// `useOpenDocument`) build targets from chat parts, search hits and notifications.

import { useCallback } from 'react';
import type { KbCitation, KbPageRef, KbSubjectRef } from '../../api/kb/types.gen';
import { useServices } from './context';

export interface DocTarget {
  type: 'page' | 'material';
  id: string;
  block_id?: string | null;
  seg?: number | null;
  quote?: string | null;
}

export interface WikiLinkFocus {
  href: string;
  label: string;
  occurrence: number;
}

export type ReaderFocusTarget = 'heading' | 'target' | 'notes' | 'transcript'
  | { blockId: string | null; materialId: string }
  | { wikiLink: WikiLinkFocus };

interface ChatCitationFocus {
  chatId: string;
  trigger: HTMLButtonElement;
}

interface ReaderFocusRequest {
  destination: ReaderFocusTarget;
  /** The initiating control may survive a same-document jump or a chat popup's exit. */
  origin?: Element | null;
}

interface ReaderNavigation extends ReaderFocusRequest {
  returnFocus?: ReaderFocusTarget;
  closeFocus?: ChatCitationFocus;
}

/** The two code-written wiki files shown read-only (B20). */
export type WikiFileName = 'index' | 'log';

export type RightView =
  | { kind: 'doc'; target: DocTarget; nonce: number; focus?: ReaderFocusRequest; closeFocus?: ChatCitationFocus }
  | { kind: 'graph'; focus?: string }
  | { kind: 'live'; materialId: string }
  | { kind: 'wikifile'; name: WikiFileName; nonce: number; focus?: ReaderFocusRequest }
  /** 0.3.1 P: an agent's permission request reviewed beside the chat (the part lives in the chat). */
  | { kind: 'review'; chatId: string; partId: string }
  /** 0.3.1 S (W2): a deck or test block beside the chat (the block is a part of its chat's message). */
  | { kind: 'study'; chatId: string; studyId: string }
  /** N8: the chat overview — Links · Used · Created of one chat. */
  | { kind: 'overview'; chatId: string };

/** What the centre column shows: the open chat, or a full-width list (decisions v16, 25). */
export type CenterView = 'chat' | 'allChats' | 'materials';

interface ReaderHistoryEntry {
  view: RightView;
  expanded: boolean;
  returnFocus?: ReaderFocusTarget;
}

function isReader(view: RightView): boolean {
  return view.kind === 'doc' || view.kind === 'wikifile' || view.kind === 'live';
}

export interface NavState {
  right: RightView | null;
  /** The right panel takes the centre instead of the chat (⤢). */
  docExpanded: boolean;
  center: CenterView;
  /** Compatibility with U1: the material shown on the right, if the right panel is a material. */
  docMaterialId: string | null;
  /** Wiki pages opened in this window, newest first (side panel "Recently opened"). */
  recentPages: string[];
  /**
   * What the right panel showed before, newest last (QA C20): "Open at quote" on a page, a link,
   * a graph node — Back (⌘[) returns to the page you were reading. ✕ forgets it.
   */
  docHistory: ReaderHistoryEntry[];
}

export interface NavActions {
  openDocument: (target: DocTarget, navigation?: ReaderNavigation) => void;
  /** U1 entry point: open one material. */
  openDoc: (materialId: string) => void;
  /** `focus`: the page to select in the graph ("Show the graph" from a page). */
  openGraph: (focus?: string) => void;
  /** Back to what the right panel showed before (no-op without history). */
  goBack: () => void;
  openLive: (materialId: string) => void;
  /** `Wiki/index.md` or `Wiki/log.md`, read-only (B20). */
  openWikiFile: (name: WikiFileName) => void;
  /** An agent's permission request beside the chat, with the decision bar at the bottom (P4). */
  openReview: (chatId: string, partId: string) => void;
  /** A study block beside the chat (it left the thread: one place at a time, A-4). */
  openStudy: (chatId: string, studyId: string) => void;
  /** N8: the chat overview beside the chat. */
  openOverview: (chatId: string) => void;
  /** Close the right panel, whatever it shows. */
  closeDoc: () => void;
  toggleDocExpanded: () => void;
  showCenter: (view: CenterView) => void;
}

let nonce = 0;
const RECENT_PAGES = 8;
const HISTORY = 30;

/** Same place in the right panel (a re-open of the same document is not a step back). */
function samePlace(a: RightView, b: RightView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'doc' && b.kind === 'doc') return a.target.type === b.target.type && a.target.id === b.target.id;
  if (a.kind === 'live' && b.kind === 'live') return a.materialId === b.materialId;
  if (a.kind === 'wikifile' && b.kind === 'wikifile') return a.name === b.name;
  if (a.kind === 'review' && b.kind === 'review') return a.partId === b.partId;
  if (a.kind === 'study' && b.kind === 'study') return a.studyId === b.studyId;
  if (a.kind === 'overview' && b.kind === 'overview') return a.chatId === b.chatId;
  return true;
}

/** The history after leaving `from` for `to`: the live view and a study block are not places to come back to. */
function pushed({ docHistory, right, docExpanded }: NavState, to: RightView, returnFocus?: ReaderFocusTarget): ReaderHistoryEntry[] {
  if (!right || right.kind === 'live' || right.kind === 'study' || samePlace(right, to)) return docHistory;
  // Clear the old entry-focus request. Back supplies a new logical destination.
  const view = right.kind === 'doc' || right.kind === 'wikifile' ? { ...right, focus: undefined } : right;
  return [...docHistory, { view, expanded: docExpanded, returnFocus }].slice(-HISTORY);
}

function materialOf(right: RightView | null): string | null {
  return right?.kind === 'doc' && right.target.type === 'material' ? right.target.id : null;
}

/** Clean a target: unknown or empty optional parts become absent, so equality is stable. */
export function normalizeTarget(target: DocTarget): DocTarget {
  const out: DocTarget = { type: target.type, id: target.id };
  if (target.block_id) out.block_id = target.block_id;
  if (typeof target.seg === 'number' && Number.isInteger(target.seg) && target.seg > 0) out.seg = target.seg;
  if (target.quote && target.quote.trim()) out.quote = target.quote;
  return out;
}

type SetNav = (partial: Partial<NavState> | ((s: NavState) => Partial<NavState>)) => void;

/** The navigation part of the UI store (spread into `createUiStore`). */
export function createNavSlice(set: SetNav): NavState & NavActions {
  const show = (right: RightView, returnFocus?: ReaderFocusTarget) => (s: NavState): Partial<NavState> => ({
    right,
    docMaterialId: materialOf(right),
    // Every reader open starts beside the chat. Other panels keep their own expansion behavior.
    docExpanded: !isReader(right) && s.right?.kind === right.kind && s.docExpanded,
    docHistory: pushed(s, right, returnFocus),
  });
  return {
    right: null,
    docExpanded: false,
    center: 'chat',
    docMaterialId: null,
    recentPages: [],
    docHistory: [],
    openDocument: (target, navigation) => set((s) => ({
      ...show({
        kind: 'doc', target: normalizeTarget(target), nonce: ++nonce,
        focus: navigation && { destination: navigation.destination, origin: navigation.origin },
        closeFocus: navigation?.closeFocus,
      }, navigation?.returnFocus)(s),
      ...(target.type === 'page' ? { recentPages: [target.id, ...s.recentPages.filter((id) => id !== target.id)].slice(0, RECENT_PAGES) } : {}),
    })),
    openDoc: (materialId) => set(show({ kind: 'doc', target: { type: 'material', id: materialId }, nonce: ++nonce })),
    openGraph: (focus) => set(show(focus ? { kind: 'graph', focus } : { kind: 'graph' })),
    goBack: () => set((s) => {
      const back = s.docHistory.at(-1);
      if (!back) return {};
      const { view, expanded, returnFocus } = back;
      const right = view.kind === 'doc' || view.kind === 'wikifile'
        ? { ...view, nonce: ++nonce, focus: { destination: returnFocus ?? 'heading' } } : view;
      return {
        right,
        docMaterialId: materialOf(right),
        docExpanded: isReader(right) ? expanded : s.right?.kind === right.kind && s.docExpanded,
        docHistory: s.docHistory.slice(0, -1),
      };
    }),
    openLive: (materialId) => set(show({ kind: 'live', materialId })),
    openWikiFile: (name) => set(show({ kind: 'wikifile', name, nonce: ++nonce })),
    openReview: (chatId, partId) => set(show({ kind: 'review', chatId, partId })),
    openStudy: (chatId, studyId) => set(show({ kind: 'study', chatId, studyId })),
    openOverview: (chatId) => set(show({ kind: 'overview', chatId })),
    closeDoc: () => set({ right: null, docMaterialId: null, docExpanded: false, docHistory: [] }),
    toggleDocExpanded: () => set((s) => ({ docExpanded: s.right ? !s.docExpanded : false })),
    showCenter: (view) => set({ center: view }),
  };
}

/** U2's name for a target: the same shape. */
export type DocRef = DocTarget;

/** The document shown on the right, if the right panel shows one (not the graph / live view). */
export function openTarget(state: NavState): DocTarget | null {
  return state.right?.kind === 'doc' ? state.right.target : null;
}

export const citationRef = (c: KbCitation): DocTarget => ({ type: 'material', id: c.material_id, seg: c.seg, quote: c.quote ?? null });
export const pageRef = (p: KbPageRef, blockId?: string | null): DocTarget => ({ type: 'page', id: p.id, block_id: blockId ?? null });
export const subjectRef = (s: KbSubjectRef): DocTarget | null =>
  s.type === 'chat' ? null : { type: s.type, id: s.id, block_id: s.block_id ?? null, seg: s.seg ?? null };

export function useOpenDocument(): NavActions['openDocument'] {
  const { ui } = useServices();
  return useCallback<NavActions['openDocument']>((ref, navigation) => ui.getState().openDocument(ref, navigation), [ui]);
}
