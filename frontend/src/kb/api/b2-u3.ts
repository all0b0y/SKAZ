// Package-2 contract (.dev/wiki-build/API-B2.md) as the U3 screens use it, until the backend of
// package 2 lands and `types.gen.ts` is regenerated. Names are the exact pydantic model names of
// the contract, so the switch is an import change: `from './b2-u3'` → `from '../../api/kb/types.gen'`.
// Nothing here invents fields: every field below is in API-B2.md (§1.3, §2, §3 for POST /kb/chats,
// §4, §5). Types already generated and unchanged by package 2 are re-exported as they are.

import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import type * as Gen from '../../api/kb/types.gen';
import { KbApiError, buildPath } from './client';

export type {
  KbCitation, KbFolder, KbLinkInfo as KbLinkInfoP1, KbMaterialGuard, KbExcludedFragment, KbSpeechMaterial,
  KbSpeechDefaults, KbOrigin, KbBlock, KbWikiSettings, KbJobProgress, KbJobLogEntry, KbMaterialAdded as KbMaterialAddedP1,
} from '../../api/kb/types.gen';

export type MaterialKind = Gen.KbMaterialSummary['kind'];
export type PageKind = Gen.KbPage['kind'];

// ---- §1.3 Material -------------------------------------------------------------------------

export type KbWikiState = 'not_in_wiki' | 'processing' | 'in_wiki' | 'failed';

export interface KbFragment extends Gen.KbFragment {
  /** Source text before recognition fixes, when it differs from `text` (text has fixes applied). */
  original_text: string | null;
  /** Ids of the corrections inside this fragment. */
  corrections: string[];
}

export interface KbTranslationFragment {
  /** null when the provider stores translation without segment ids (Soniox): paragraphs in order. */
  seg: number | null;
  text: string;
}

export interface KbTranslation {
  language: string;
  fragments: KbTranslationFragment[];
}

export interface KbMaterialWiki {
  state: KbWikiState;
  note_page_id: string | null;
  concept_count: number;
  job_id: string | null;
  error: string | null;
}

export interface KbCorrectionCounts {
  applied: number;
  doubtful: number;
}

export interface KbMaterial extends Omit<Gen.KbMaterial, 'fragments'> {
  fragments: KbFragment[];
  translation: KbTranslation | null;
  wiki: KbMaterialWiki;
  excluded_count: number;
  correction_counts: KbCorrectionCounts;
}

export interface KbMaterialSummary extends Gen.KbMaterialSummary {
  wiki_state: KbWikiState;
  folder_name: string;
}

export interface KbMaterialAdded extends Omit<Gen.KbMaterialAdded, 'material'> {
  material: KbMaterialSummary;
}

export interface KbMaterialUpdate {
  title?: string;
  folder_id?: string;
}

// ---- §2.1 Corrections ----------------------------------------------------------------------

export type KbCorrectionState = 'applied' | 'doubtful' | 'reverted' | 'kept';

export interface KbCorrection {
  id: string;
  material_id: string;
  seg: number;
  before: string;
  after: string;
  reason: string;
  confidence: number | null;
  state: KbCorrectionState;
  auto: boolean;
  created_at: string;
  decided_at: string | null;
}

export interface KbCorrectionChange {
  correction: KbCorrection;
  affected_blocks: number;
  job: KbJob | null;
}

// ---- §2.3 Delete --------------------------------------------------------------------------

export interface KbPageRef {
  id: string;
  kind: PageKind;
  title: string;
}

export interface KbDeletePreview {
  material_id: string;
  title: string;
  claims_removed: number;
  claims_kept: number;
  pages_changed: KbPageRef[];
  pages_removed: KbPageRef[];
  connections_removed: number;
  user_notes_kept: number;
}

// ---- §2.4 Pages -----------------------------------------------------------------------------

export interface KbPage extends Gen.KbPage {
  related: KbPageRef[];
  mentioned_in: KbPageRef[];
  folder_names: string[];
  updated_at: string;
  is_analysis_source_forbidden: boolean;
}

export interface KbBlockEdit {
  text: string;
}

export interface KbBlockCreate {
  text: string;
  after_block_id?: string | null;
  section?: string | null;
}

// ---- §2.5 Graph ---------------------------------------------------------------------------

export interface KbGraphNode {
  id: string;
  kind: 'concept' | 'note' | 'analysis' | 'folder';
  title: string;
  folder_ids: string[];
  degree: number;
  hub: boolean;
}

export interface KbGraphEdge {
  source: string;
  target: string;
  kind: 'link' | 'connection';
  cross_folder: boolean;
  page_id: string | null;
  block_id: string | null;
}

export interface KbGraph {
  nodes: KbGraphNode[];
  edges: KbGraphEdge[];
}

// ---- §2.6 Jobs ------------------------------------------------------------------------------

export type KbJobKind = 'ingest' | 'refresh' | 'recheck' | 'connections' | 'folder_overview' | 'corrections';

export interface KbJob extends Omit<Gen.KbJob, 'kind' | 'step'> {
  kind: KbJobKind;
  /** Package 1 steps + `checking_recognition` (§2.1); new steps of W2 are shown by their label. */
  step: Gen.KbJob['step'] | 'checking_recognition' | (string & {}) | null;
}

// ---- §4 Links -------------------------------------------------------------------------------

export interface KbLinkInfo extends Gen.KbLinkInfo {
  /** An article that embeds a video: the user is asked text / video / both. */
  embedded_video: Gen.KbLinkInfo | null;
}

export interface KbAddLink extends Gen.KbAddLink {
  mode?: 'text' | 'video' | 'both';
}

// ---- §3 Chats (only the recording chat is created here; the chat itself is U2) -------------

export type EngineId = 'codex' | 'claude_code' | 'hermes';

export interface KbChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  engine: EngineId;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
  last_preview: string;
  recording_material_id: string | null;
  folder_ids: string[];
  state: 'idle' | 'answering';
  unread: boolean;
}

export interface KbChatCreate {
  title?: string | null;
  engine?: EngineId | null;
  model?: string | null;
  effort?: string | null;
  recording_material_id?: string | null;
}

/** `KbChat` = summary + messages + cursor; messages are U2's model and are not read here. */
export interface KbChat extends KbChatSummary {
  messages: unknown[];
  cursor: number;
}

// ---- §5 Bridge (U2 adds the method; U3 calls it when present) ------------------------------

export interface MaterialFileChoice {
  path: string;
  name: string;
  size: number;
}

export interface BridgeB2 {
  chooseMaterialFiles?(): Promise<MaterialFileChoice[]>;
}

// ---- Tolerance for the package-1 backend ----------------------------------------------------
// Until package 2 is merged the backend answers in the package-1 shape (no translation, wiki,
// corrections…). These fill only neutral empties — never a claim: a missing `wiki` stays missing.

type Loose<T> = { [K in keyof T]?: T[K] };

export function normalizeMaterial(raw: Loose<KbMaterial> & Gen.KbMaterial): KbMaterial {
  return {
    ...raw,
    fragments: (raw.fragments as Array<Loose<KbFragment> & Gen.KbFragment>).map((f) => ({
      ...f, original_text: f.original_text ?? null, corrections: f.corrections ?? [],
    })),
    translation: raw.translation ?? null,
    wiki: raw.wiki as KbMaterialWiki,
    excluded_count: raw.excluded_count ?? 0,
    correction_counts: raw.correction_counts ?? { applied: 0, doubtful: 0 },
  };
}

export function normalizePage(raw: Loose<KbPage> & Gen.KbPage): KbPage {
  return {
    ...raw,
    related: raw.related ?? [],
    mentioned_in: raw.mentioned_in ?? [],
    folder_names: raw.folder_names ?? [],
    updated_at: raw.updated_at ?? '',
    is_analysis_source_forbidden: raw.is_analysis_source_forbidden ?? raw.kind === 'analysis',
  };
}

export function normalizeSummary(raw: Loose<KbMaterialSummary> & Gen.KbMaterialSummary): KbMaterialSummary {
  return { ...raw, wiki_state: raw.wiki_state as KbWikiState, folder_name: raw.folder_name ?? '' };
}

// ---- Routes ---------------------------------------------------------------------------------

type None = Record<string, never>;
interface Route<P, Q, B, R> { path: P; query: Q; body: B; response: R }

/** The /kb routes the U3 screens call, with package-2 shapes (same layout as `KbEndpoints`). */
export interface U3Endpoints {
  'GET /kb/materials': Route<None, { folder_id?: string | null; kind?: MaterialKind | null }, never, KbMaterialSummary[]>;
  'GET /kb/materials/{material_id}': Route<{ material_id: string }, None, never, KbMaterial>;
  'PATCH /kb/materials/{material_id}': Route<{ material_id: string }, None, KbMaterialUpdate, KbMaterial>;
  'DELETE /kb/materials/{material_id}': Route<{ material_id: string }, None, never, KbDeletePreview>;
  'GET /kb/materials/{material_id}/delete-preview': Route<{ material_id: string }, None, never, KbDeletePreview>;
  'GET /kb/materials/{material_id}/corrections': Route<{ material_id: string }, None, never, KbCorrection[]>;
  'GET /kb/materials/{material_id}/excluded': Route<{ material_id: string }, None, never, Gen.KbMaterialGuard>;
  'POST /kb/materials/{material_id}/excluded/{seg}/restore': Route<{ material_id: string; seg: string }, None, never, Gen.KbMaterialGuard>;
  'POST /kb/materials/{material_id}/ingest': Route<{ material_id: string }, None, never, KbJob>;
  'POST /kb/materials/file': Route<None, None, Gen.KbAddFile, KbMaterialAdded>;
  'POST /kb/materials/link': Route<None, None, KbAddLink, KbMaterialAdded>;
  'POST /kb/materials/text': Route<None, None, Gen.KbAddText, KbMaterialAdded>;
  'POST /kb/links/classify': Route<None, None, Gen.KbClassifyLink, KbLinkInfo>;
  'POST /kb/corrections/{correction_id}/revert': Route<{ correction_id: string }, None, never, KbCorrectionChange>;
  'POST /kb/corrections/{correction_id}/accept': Route<{ correction_id: string }, None, never, KbCorrectionChange>;
  'POST /kb/corrections/{correction_id}/keep': Route<{ correction_id: string }, None, never, KbCorrectionChange>;
  'POST /kb/corrections/{correction_id}/reapply': Route<{ correction_id: string }, None, never, KbCorrectionChange>;
  'GET /kb/jobs': Route<None, { material_id?: string | null }, never, KbJob[]>;
  'GET /kb/jobs/{job_id}': Route<{ job_id: string }, None, never, KbJob>;
  'GET /kb/wiki/pages': Route<None, { kind?: PageKind | null; folder_id?: string | null }, never, Gen.KbPageSummary[]>;
  'GET /kb/wiki/pages/{page_id}': Route<{ page_id: string }, None, never, KbPage>;
  'PUT /kb/wiki/pages/{page_id}/blocks/{block_id}': Route<{ page_id: string; block_id: string }, None, KbBlockEdit, KbPage>;
  'POST /kb/wiki/pages/{page_id}/blocks': Route<{ page_id: string }, None, KbBlockCreate, KbPage>;
  'DELETE /kb/wiki/pages/{page_id}/blocks/{block_id}': Route<{ page_id: string; block_id: string }, None, never, KbPage>;
  'POST /kb/wiki/pages/{page_id}/blocks/{block_id}/recheck': Route<{ page_id: string; block_id: string }, None, never, KbJob>;
  'GET /kb/graph': Route<None, { folder_id?: string | null }, never, KbGraph>;
  'GET /kb/settings/wiki': Route<None, None, never, Gen.KbWikiSettings>;
  'GET /kb/recordings/defaults': Route<None, None, never, Gen.KbSpeechDefaults>;
  'POST /kb/recordings': Route<None, None, Gen.KbRecordingCreate, Gen.KbSpeechMaterial>;
  'GET /kb/recordings/{material_id}': Route<{ material_id: string }, None, never, Gen.KbSpeechMaterial>;
  'POST /kb/recordings/{material_id}/stop': Route<{ material_id: string }, None, never, Gen.KbSpeechMaterial>;
  'POST /kb/recordings/{material_id}/pause': Route<{ material_id: string }, None, never, Gen.KbSpeechMaterial>;
  'POST /kb/recordings/{material_id}/resume': Route<{ material_id: string }, None, never, Gen.KbSpeechMaterial>;
  'POST /kb/imports': Route<None, None, Gen.KbImportCreate, Gen.KbSpeechMaterial>;
  'POST /kb/chats': Route<None, None, KbChatCreate, KbChat>;
}

export type U3Route = keyof U3Endpoints;
type Spec<R extends U3Route> = U3Endpoints[R];

/** Thin typed caller for `U3Endpoints` over the same preload bridge as `KbClient`. */
export class KbU3Client {
  constructor(private readonly bridge: Pick<BridgeApi, 'request'>) {}

  async call<R extends U3Route>(route: R, options: {
    path?: Spec<R>['path'];
    query?: Partial<Spec<R>['query']>;
    body?: Spec<R>['body'];
  } = {}): Promise<Spec<R>['response']> {
    const space = route.indexOf(' ');
    const method = route.slice(0, space) as BridgeRequest['method'];
    const path = buildPath(route.slice(space + 1), options.path as Record<string, string> | undefined);
    const query: BridgeRequest['query'] = {};
    for (const [key, value] of Object.entries((options.query ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[key] = value;
    }
    const res: JsonResponse<Spec<R>['response']> = await this.bridge.request({
      method, path, query: Object.keys(query).length ? query : undefined, body: options.body,
    });
    if (!res.ok) throw new KbApiError(res.status, res.detail || `Request failed (${res.status}).`);
    return res.data;
  }
}
