// Shared navigator of the right document panel (U3). Anything that links to a wiki page or a
// material — a citation chip, a search result, a notification, a graph node — calls
// `openDocument({type, id, block_id?, seg?, quote?})` on the UI store:
//   - type "page": opens the wiki page; `block_id` scrolls to and briefly marks that block;
//   - type "material": opens the material; `seg` scrolls to that fragment, `quote` highlights
//     exactly that checked quote inside it (KbCitation.quote), not the whole fragment.
// Opening the same target again re-runs the scroll/highlight (a new `nonce`).
// The right panel also hosts the graph and the live recording; "All materials" takes the centre.

export interface DocTarget {
  type: 'page' | 'material';
  id: string;
  block_id?: string | null;
  seg?: number | null;
  quote?: string | null;
}

export type RightView =
  | { kind: 'doc'; target: DocTarget; nonce: number }
  | { kind: 'graph' }
  | { kind: 'live'; materialId: string };

export type CenterView = 'chat' | 'materials';

export interface NavState {
  right: RightView | null;
  /** The right panel takes the centre instead of the chat (⤢). */
  docExpanded: boolean;
  center: CenterView;
  /** Compatibility with U1: the material shown on the right, if the right panel is a material. */
  docMaterialId: string | null;
  /** Wiki pages opened in this window, newest first (side panel "Recently opened"). */
  recentPages: string[];
}

export interface NavActions {
  openDocument: (target: DocTarget) => void;
  /** U1 entry point: open one material. */
  openDoc: (materialId: string) => void;
  openGraph: () => void;
  openLive: (materialId: string) => void;
  /** Close the right panel, whatever it shows. */
  closeDoc: () => void;
  toggleDocExpanded: () => void;
  showCenter: (view: CenterView) => void;
}

let nonce = 0;
const RECENT_PAGES = 8;

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
  const show = (right: RightView | null) => (s: NavState): Partial<NavState> => ({
    right,
    docMaterialId: materialOf(right),
    // A different kind of panel starts in the side position; the same kind keeps ⤢.
    docExpanded: right !== null && s.right?.kind === right.kind ? s.docExpanded : false,
  });
  return {
    right: null,
    docExpanded: false,
    center: 'chat',
    docMaterialId: null,
    recentPages: [],
    openDocument: (target) => set((s) => ({
      ...show({ kind: 'doc', target: normalizeTarget(target), nonce: ++nonce })(s),
      ...(target.type === 'page' ? { recentPages: [target.id, ...s.recentPages.filter((id) => id !== target.id)].slice(0, RECENT_PAGES) } : {}),
    })),
    openDoc: (materialId) => set(show({ kind: 'doc', target: { type: 'material', id: materialId }, nonce: ++nonce })),
    openGraph: () => set(show({ kind: 'graph' })),
    openLive: (materialId) => set(show({ kind: 'live', materialId })),
    closeDoc: () => set({ right: null, docMaterialId: null, docExpanded: false }),
    toggleDocExpanded: () => set((s) => ({ docExpanded: s.right ? !s.docExpanded : false })),
    showCenter: (view) => set({ center: view }),
  };
}
