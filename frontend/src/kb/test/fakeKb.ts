// The one fake backend of the new interface: an in-memory `FakeWorld` and a router typed by the
// generated contract (`KbEndpoints` from types.gen.ts, made from the backend OpenAPI schema).
// Every handler is keyed by a real backend route and must return that route's generated response
// type, so the fake cannot answer a route the backend does not have or in a shape it does not use.
// Used by component tests (fakeBridge.ts, with vi.fn), the browser smoke (browserFake.ts) and the
// U3 smoke (scripts/u3-smoke/fakeSkaz.ts) — pure, no test-runner imports.
// A fake on the external seam: it proves the UI's handling of contract-shaped answers, not the
// backend's behaviour (that is scripts/kb-shell.smoke.spec.ts on the real backend).

import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { NativeAudioMeta, NativeOpened, NativeSaved, NativeStopped } from '../../api/nativeLive';
import type {
  KbAbout, KbAgents, KbBlock, KbChat, KbCitation, KbChatEvent, KbChatSummary, KbCorrection, KbDecisions, KbDeletePreview,
  KbDictation, KbEndpoints, KbFolder, KbFragment, KbGraph, KbInstallTask, KbJob, KbKeys, KbLibrary, KbLinkInfo,
  KbMaterial, KbMaterialAdded, KbMaterialGuard, KbMaterialSummary, KbMessage, KbNotification, KbPage, KbPageRef,
  KbPageSummary, KbPrivacy, KbRef, KbRoute, KbSearchResults, KbSettingsHealth, KbSpeechMaterial, KbSpeechSettings,
  KbWikiSettings,
} from '../../api/kb/types.gen';

// ---- The world -------------------------------------------------------------------------------

export interface FakeExcluded {
  seg: number;
  found: string;
  reason: string;
  label: string;
  start_ms: number | null;
  restored: boolean;
}

export interface FakeWorld {
  library: KbLibrary;
  folders: KbFolder[];
  materials: KbMaterial[];
  corrections: KbCorrection[];
  /** Fragments left out as instructions to an AI, by material. */
  excluded: Record<string, FakeExcluded[]>;
  pages: KbPage[];
  graph: KbGraph;
  jobs: KbJob[];
  recordings: Record<string, KbSpeechMaterial>;
  lastFolderId: string;
  // Chats (C1)
  chats: KbChat[];
  /** Per chat: every event so far (the long poll answers those after `after`). */
  chatEvents: Record<string, KbChatEvent[]>;
  listCursor: number;
  listChanges: Array<{ seq: number; chat: KbChatSummary }>;
  /** Answers stay "streaming" until `finishAnswer` (to see Stop, the answering indicator…). */
  hold: boolean;
  pendingAnswers: Record<string, KbChatEvent[]>;
  // Notifications (W2)
  notifications: KbNotification[];
  notificationSeq: number;
  readUpTo: number;
  // Settings, agents (S3, A2, D1)
  agents: KbAgents;
  installTasks: Record<string, KbInstallTask>;
  keys: KbKeys;
  speech: KbSpeechSettings;
  wiki: KbWikiSettings;
  decisions: KbDecisions;
  privacy: KbPrivacy;
  about: KbAbout;
  health: KbSettingsHealth;
  /** What `bridge.dictate` answers (main → POST /kb/dictation). */
  dictation: { text: string } | { status: number; detail: string };
  // Old routes the recording reuses (frontend/src/audio pipeline)
  settings: Record<string, unknown>;
  /** Unstable words of the live recording (GET /kb/recordings/{id}/live → partial). */
  liveTail: string;
  /**
   * Continuous speech: final words of a monologue that hasn't closed (no pause, no other speaker).
   * Set, the recording's material doesn't grow — the words come only through `live` (`monologues`).
   */
  liveOpen?: string;
  /** `GET /logs`: the technical activity log (absent = nothing ran yet). */
  activity?: { entries: Array<Record<string, unknown>>; capacity: number; dropped: number };
  /** The recording's stream state in the same answer (`stream`); absent = streaming. */
  liveTranscription?: 'connecting' | 'reconnecting' | 'streaming' | 'unavailable' | 'inactive';
  /** One-off failures: "METHOD /path" → status + detail. */
  failures: Record<string, { status: number; detail: string }>;
  /** Route prefixes this backend lacks (answer 404 "Not Found", as FastAPI does): an older or broken backend. */
  missing?: string[];
  /** Every request served, for assertions. */
  log: Array<{ method: string; path: string; body?: unknown }>;
  seq: number;
  /** Fixed clock of the fixtures (ISO), or null to follow the real clock (scenes with "Today"). */
  now: string | null;
  /** What a new streamed answer cites (defaults: the first concept page, the last fragment of the first material). */
  answerPage?: KbPageRef;
  answerCite?: KbCitation;
}

/** A failed request: HTTP status + the backend's plain-English `detail`. */
export class FakeHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
  }
}

const fail = (status: number, detail: string): never => { throw new FakeHttpError(status, detail); };

// ---- Small builders shared with fixtures.ts ----------------------------------------------------

export function fragment(materialId: string, seg: number, text: string, extra: Partial<KbFragment> = {}): KbFragment {
  return {
    id: `${materialId}-f${seg}`, seg, text, start_ms: null, end_ms: null, speaker: null, page: null, index: seg - 1,
    role: 'paragraph', level: null, original_text: null, corrections: [], ...extra,
  };
}

export function materialWiki(state: KbMaterial['wiki']['state'], extra: Partial<KbMaterial['wiki']> = {}): KbMaterial['wiki'] {
  return { state, note_page_id: null, concept_count: 0, job_id: null, error: null, error_code: null, ...extra };
}

export function block(id: string, kind: KbBlock['kind'], section: string | null, text: string,
  citations: KbBlock['citations'] = [], owner: KbBlock['owner'] = kind === 'user_note' ? 'user' : 'agent'): KbBlock {
  return { id, kind, owner, marked: true, section, text, hash: id, citations };
}

export function pageRef(p: Pick<KbPage, 'id' | 'kind' | 'title'>): KbPageRef {
  return { id: p.id, kind: p.kind, title: p.title };
}

function folderName(world: FakeWorld, id: string): string {
  return world.folders.find((f) => f.id === id)?.name ?? '';
}

export function summaryOf(world: FakeWorld, m: KbMaterial): KbMaterialSummary {
  return {
    id: m.id, title: m.title, kind: m.kind, status: m.status, folder_id: m.folder_id, languages: m.languages,
    created_at: m.created_at, fragment_count: m.fragments.length, wiki_state: m.wiki.state, folder_name: folderName(world, m.folder_id),
  };
}

/** The whole material as GET /kb/materials/{id} answers (folder name and counts kept current). */
function materialView(world: FakeWorld, m: KbMaterial): KbMaterial {
  const excluded = (world.excluded[m.id] ?? []).filter((x) => !x.restored).length;
  return { ...structuredClone(m), ...summaryOf(world, m), excluded_count: excluded };
}

function pageSummary(p: KbPage): KbPageSummary {
  return { id: p.id, kind: p.kind, title: p.title, original: p.original, aliases: p.aliases, folders: p.folders, sources: p.sources, language: p.language };
}

function chatSummary(c: KbChat): KbChatSummary {
  const { messages: _m, cursor: _c, ...rest } = c;
  void _m; void _c;
  return rest;
}

/** The world's time now: the fixed clock, or the real one. */
const stamp = (world: FakeWorld) => world.now ?? new Date().toISOString();
/** A time for something new: on a fixed clock each new thing is a minute later than the last. */
const clock = (world: FakeWorld, step = world.seq) => (world.now ? new Date(Date.parse(stamp(world)) + step * 60_000).toISOString() : new Date().toISOString());

// ---- Materials ------------------------------------------------------------------------------

function findMaterial(world: FakeWorld, id: string): KbMaterial {
  return world.materials.find((m) => m.id === id) ?? fail(404, 'Material not found.');
}

function newMaterial(world: FakeWorld, title: string, kind: KbMaterial['kind'], folderId: string, status: KbMaterial['status'], text: string[]): KbMaterial {
  const id = `m-new${++world.seq}`;
  const m: KbMaterial = {
    id, title, kind, status, folder_id: folderId, languages: ['en'], created_at: clock(world), fragment_count: text.length,
    wiki_state: 'not_in_wiki', folder_name: folderName(world, folderId), origin: null,
    fragments: text.map((t, i) => fragment(id, i + 1, t)), correction_counts: { applied: 0, doubtful: 0 }, translation: null,
    wiki: materialWiki(status === 'ready' ? 'not_in_wiki' : 'processing'), excluded_count: 0,
  };
  world.materials.unshift(m);
  world.lastFolderId = folderId;
  return m;
}

function added(world: FakeWorld, m: KbMaterial): KbMaterialAdded {
  return { material: summaryOf(world, m), excluded_count: 0, hidden_count: 0, failure_reason: null, video: null, video_failure_reason: null };
}

function newJob(world: FakeWorld, kind: KbJob['kind'], materialId: string | null, state: KbJob['state'] = 'done', label: string = kind): KbJob {
  const job: KbJob = {
    id: `j${++world.seq}`, kind, material_id: materialId, state, step: state === 'done' ? 'done' : 'reading', label, error: null, error_code: null, can_retry: false,
    progress: { parts_total: 1, parts_done: state === 'done' ? 1 : 0, concepts_found: 0, blocks_written: 0, blocks_dropped: 0, blocks_blocked: 0, concepts_created: 0, concepts_updated: 0 },
    journal: [], created_at: stamp(world), updated_at: stamp(world),
  };
  world.jobs.push(job);
  return job;
}

function speechView(m: KbMaterial, sessionId: string, recording: KbSpeechMaterial['recording_state']): KbSpeechMaterial {
  return {
    material_id: m.id, session_id: sessionId, kind: m.kind as KbSpeechMaterial['kind'], title: m.title, folder_id: m.folder_id,
    status: m.status, fragment_count: m.fragments.length, created_at: m.created_at, recording_state: recording,
    import_state: null, import_stage: null, error: null,
  };
}

function guardOf(world: FakeWorld, materialId: string): KbMaterialGuard {
  const list = world.excluded[materialId] ?? [];
  return {
    material_id: materialId,
    excluded: list.filter((x) => !x.restored).map((x) => ({
      seg: x.seg, id: `${materialId}-x${x.seg}`, reason: x.reason, rules: ['instruction'], score: 0.9, found: x.found,
      location: { index: x.seg, page: null, start_ms: x.start_ms, label: x.label }, text_hash: 'h', detected_at: stamp(world),
    })),
    restored: list.filter((x) => x.restored).map((x) => ({ seg: x.seg, text_hash: 'h', restored_at: stamp(world) })),
    hidden: [], failure_reason: null,
  };
}

function deletePreview(world: FakeWorld, m: KbMaterial): KbDeletePreview {
  const touched = world.pages.filter((p) => p.blocks.some((b) => b.citations.some((c) => c.material_id === m.id)));
  return {
    material_id: m.id, title: m.title,
    claims_removed: touched.reduce((n, p) => n + p.blocks.filter((b) => b.citations.length > 0 && b.citations.every((c) => c.material_id === m.id)).length, 0),
    claims_kept: 1,
    pages_changed: touched.filter((p) => p.kind !== 'note').map(pageRef),
    pages_removed: touched.filter((p) => p.kind === 'note').map(pageRef),
    connections_removed: 2,
    user_notes_kept: 1,
  };
}

/** Classify like decision 40: four video hosts, PDF by extension, everything else is a site. */
export function classifyFake(url: string): KbLinkInfo {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* invalid */ }
  const video = /(^|\.)(youtube\.com|youtu\.be|vk\.com|vkvideo\.ru|rutube\.ru|vimeo\.com)$/.test(host);
  const info: KbLinkInfo = {
    kind: video ? 'video' : /\.pdf$/i.test(url) ? 'pdf' : 'site', url, domain: host, label: host,
    platform: video ? 'youtube' : null, video_id: null, title: video ? 'Seminar on entropy' : null,
    duration_ms: video ? 64 * 60_000 : null, supported: true, note: null, embedded_video: null,
  };
  if (/embed/.test(url)) info.embedded_video = { ...info, kind: 'video', platform: 'youtube', title: 'Embedded talk', duration_ms: 20 * 60_000 };
  return info;
}

function applyCorrection(world: FakeWorld, c: KbCorrection, action: 'revert' | 'accept' | 'keep' | 'reapply') {
  const from: Record<typeof action, KbCorrection['state']> = { revert: 'applied', accept: 'doubtful', keep: 'doubtful', reapply: 'reverted' };
  if (c.state !== from[action]) fail(409, 'This correction has already been decided.');
  const m = world.materials.find((x) => x.id === c.material_id);
  const f = m?.fragments.find((x) => x.seg === c.seg);
  const counts = m?.correction_counts ?? { applied: 0, doubtful: 0 };
  if (action === 'revert') { c.state = 'reverted'; if (f) f.text = f.text.replace(c.after, c.before); counts.applied -= 1; }
  if (action === 'accept' || action === 'reapply') {
    if (action === 'accept') counts.doubtful -= 1;
    c.state = 'applied'; if (f) f.text = f.text.replace(c.before, c.after); counts.applied += 1;
  }
  if (action === 'keep') { c.state = 'kept'; counts.doubtful -= 1; }
  c.decided_at = stamp(world);
  return { correction: structuredClone(c), affected_blocks: action === 'keep' ? 0 : 2, job: null };
}

// ---- Chats ----------------------------------------------------------------------------------

function findChat(world: FakeWorld, id: string): KbChat {
  return world.chats.find((c) => c.id === id) ?? fail(404, 'Chat not found.');
}

function pushEvent(world: FakeWorld, chatId: string, event: Omit<KbChatEvent, 'seq'>): void {
  const list = (world.chatEvents[chatId] ??= []);
  const c = world.chats.find((x) => x.id === chatId);
  const seq = (c?.cursor ?? 0) + 1;
  if (c) c.cursor = seq;
  list.push({ ...event, seq });
}

function touchList(world: FakeWorld, c: KbChat): void {
  world.listCursor += 1;
  world.listChanges.push({ seq: world.listCursor, chat: chatSummary(c) });
}

function applyToMessage(m: KbMessage, e: Omit<KbChatEvent, 'seq'>): void {
  if (e.type === 'delta' && e.text) {
    const last = m.parts[m.parts.length - 1];
    if (last && last.type === 'text') last.text += e.text;
    else m.parts.push({ type: 'text', text: e.text });
  } else if (e.type === 'part' && e.part) {
    m.parts.push(e.part);
  } else if ((e.type === 'state' || e.type === 'message') && e.message) {
    Object.assign(m, e.message);
  }
}

function emit(world: FakeWorld, c: KbChat, events: Array<Omit<KbChatEvent, 'seq'>>): void {
  for (const e of events) {
    pushEvent(world, c.id, e);
    const m = c.messages.find((x) => x.id === e.message_id);
    if (m) applyToMessage(m, e);
  }
}

export function chatMessage(id: string, seq: number, role: KbMessage['role'], at: string, parts: KbMessage['parts'],
  extra: Partial<KbMessage> = {}): KbMessage {
  return {
    id, seq, role, created_at: at, engine: role === 'assistant' ? 'claude_code' : null,
    model: role === 'assistant' ? 'claude-opus-5-5' : null, state: 'done', parts, failure: null, saved_page_id: null,
    input: role === 'user' ? { text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), mentions: [], quotes: [], attachments: [] } : null,
    ...extra,
  };
}

/** What a streamed answer says: text, a page chip and a source chip of the world, when it has them. */
function answerEvents(world: FakeWorld, id: string, question: string): Array<Omit<KbChatEvent, 'seq'>> {
  if (/limit/i.test(question)) {
    return [{ type: 'state', message_id: id, message: null, text: 'limit' }];
  }
  const concept = world.pages.find((p) => p.kind === 'concept');
  const page = world.answerPage ?? (concept ? pageRef(concept) : null);
  const cited = world.materials.find((m) => m.fragments.length > 0);
  const last = cited?.fragments[cited.fragments.length - 1];
  const citation: KbCitation | null = world.answerCite ?? (cited && last ? {
    material_id: cited.id, seg: last.seg, available: true, material_title: cited.title, start_ms: last.start_ms, end_ms: last.end_ms, page: last.page, quote: null,
  } : null);
  const events: Array<Omit<KbChatEvent, 'seq'>> = [{ type: 'delta', message_id: id, text: 'Cross-entropy is Shannon entropy applied to the model’s error ' }];
  if (page) events.push({ type: 'part', message_id: id, part: { type: 'page', page, block_id: null } });
  if (citation) {
    events.push({ type: 'delta', message_id: id, text: '. See the classifier example ' });
    events.push({ type: 'part', message_id: id, part: { type: 'cite', citation } });
  }
  events.push({ type: 'delta', message_id: id, text: '.' });
  return events;
}

const finishers = new WeakMap<FakeWorld, Record<string, () => void>>();

function startAnswer(world: FakeWorld, c: KbChat, question: string): KbMessage {
  const id = `${c.id}-a${++world.seq}`;
  const assistant: KbMessage = {
    id, seq: (c.messages.at(-1)?.seq ?? 0) + 1, role: 'assistant', created_at: clock(world), engine: c.engine,
    model: c.model, state: 'streaming', parts: [], failure: null, saved_page_id: null, input: null,
  };
  c.messages.push(assistant);
  c.state = 'answering';
  pushEvent(world, c.id, { type: 'message', message_id: id, message: structuredClone(assistant) });
  const rest = answerEvents(world, id, question);
  const finish = () => {
    const m = c.messages.find((x) => x.id === id)!;
    if (rest[0]?.text === 'limit') {
      emit(world, c, [{ type: 'state', message_id: id, message: {
        ...structuredClone(m), state: 'interrupted', failure: { kind: 'limit', message: 'ChatGPT subscription limit reached.', retry_at: '2026-10-15T18:00:00Z' },
      } }]);
    } else {
      emit(world, c, rest);
      emit(world, c, [{ type: 'state', message_id: id, message: { ...structuredClone(m), state: 'done' } }]);
    }
    c.state = 'idle';
    c.last_preview = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').slice(0, 80);
    c.updated_at = clock(world);
    touchList(world, c);
  };
  const map = finishers.get(world) ?? {};
  finishers.set(world, map);
  map[c.id] = finish;
  if (world.hold) world.pendingAnswers[c.id] = rest.map((e) => ({ ...e, seq: 0 }));
  else finish();
  return assistant;
}

/** Let a held answer finish (all its remaining events become visible to the next poll). */
/** The backend's speech problem `speech-soniox-consent` and the Soniox privacy flow (S3, review B2 #6). */
export function syncSpeechConsent(w: FakeWorld): void {
  const speech = w.health.sections.find((s) => s.id === 'speech');
  const needed = w.speech.provider === 'soniox' && !w.speech.cloud_consent;
  if (speech) {
    speech.problems = speech.problems.filter((p) => p.id !== 'speech-soniox-consent');
    if (needed) {
      speech.problems.push({
        id: 'speech-soniox-consent', severity: 'error', title: 'Sending audio to Soniox is off',
        reason: 'Speech goes to Soniox, but sending audio to the cloud isn’t allowed. Allowing it sends the audio of recordings, imported media and dictation to Soniox for recognition.',
        still_works: 'Everything except new speech recognition.', stopped: 'New recordings, imports and dictation aren’t recognised.', progress: null,
        actions: [{ id: 'allow_soniox', label: 'Allow sending audio to Soniox', primary: true }, { id: 'use_local', label: 'Recognise on this Mac', primary: false }],
      });
    }
    speech.state = speech.problems.some((p) => p.severity === 'error') ? 'error' : speech.problems.length ? 'warning' : 'ok';
  }
  for (const flow of w.privacy.flows) if (/soniox/i.test(flow.where)) flow.enabled = w.speech.provider === 'soniox' && w.speech.cloud_consent;
}

export function finishAnswer(world: FakeWorld, chatId: string): void {
  delete world.pendingAnswers[chatId];
  finishers.get(world)?.[chatId]?.();
}

function chatMatches(c: KbChat, q: string): boolean {
  const needle = q.toLocaleLowerCase();
  return c.title.toLocaleLowerCase().includes(needle) || c.last_preview.toLocaleLowerCase().includes(needle);
}

function snippet(text: string, q: string) {
  const i = text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
  if (!q || i < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, i), match: false },
    { text: text.slice(i, i + q.length), match: true },
    { text: text.slice(i + q.length), match: false },
  ].filter((p) => p.text);
}

/** ⌘K: pages and materials by title; fragments and blocks containing the words. */
function search(world: FakeWorld, q: string): KbSearchResults {
  const needle = q.toLocaleLowerCase().trim();
  const has = (t: string) => needle.length > 0 && t.toLocaleLowerCase().includes(needle);
  const pages = world.pages.filter((p) => has(p.title)).map((p) => ({ id: p.id, title: p.title, kind: p.kind, matched_alias: null }));
  const materials = world.materials.filter((m) => has(m.title)).map((m) => ({
    id: m.id, title: m.title, kind: m.kind, folder_id: m.folder_id, folder_name: folderName(world, m.folder_id), created_at: m.created_at, snippet: snippet(m.title, q),
  }));
  const fragments = world.materials.flatMap((m) => m.fragments.filter((f) => has(f.text)).slice(0, 1).map((f) => ({
    material_id: m.id, material_title: m.title, material_kind: m.kind, seg: f.seg, start_ms: f.start_ms, page: f.page, snippet: snippet(f.text, q),
  }))).slice(0, 5);
  const blocks = world.pages.flatMap((p) => p.blocks.filter((b) => has(b.text)).slice(0, 1).map((b) => ({
    page_id: p.id, page_title: p.title, page_kind: p.kind, block_id: b.id, kind: b.kind, owner: b.owner, snippet: snippet(b.text, q),
  }))).slice(0, 5);
  return { query: q, pages, blocks, fragments, materials, counts: { wiki: pages.length + blocks.length, materials: materials.length + fragments.length, chats: 0 } };
}

// ---- Notifications --------------------------------------------------------------------------

function bump(world: FakeWorld, n: KbNotification): void {
  world.notificationSeq += 1;
  n.seq = world.notificationSeq;
}

// ---- The typed route table ------------------------------------------------------------------

type Spec<R extends KbRoute> = KbEndpoints[R];
interface Call<R extends KbRoute> {
  path: Spec<R>['path'];
  query: Partial<Spec<R>['query']>;
  body: Spec<R>['body'];
}
type Handler<R extends KbRoute> = (world: FakeWorld, call: Call<R>) => Spec<R>['response'];
/** [success status, handler]: the status literal is checked against the generated route. */
type Entry<R extends KbRoute> = readonly [Spec<R>['status'], Handler<R>];
export type FakeRoutes = { [R in KbRoute]?: Entry<R> };

const ROUTES: FakeRoutes = {
  // -- library, folders --
  'GET /kb/library': [200, (w) => w.library],
  'POST /kb/library': [200, (w, { body }) => {
    const root = body.path ? `${body.path}/SKAZ` : w.library.suggested_root;
    w.library = { ...w.library, state: 'ready', root, library_id: w.library.library_id ?? 'lib-new', reason: null };
    if (!w.folders.some((f) => f.system)) w.folders.push({ id: 'inbox', name: 'Inbox', system: true, material_count: 0, created_at: stamp(w) });
    return w.library;
  }],
  'POST /kb/library/retry': [200, (w) => w.library],
  'GET /kb/folders': [200, (w) => w.folders.map((f) => ({ ...f, material_count: w.materials.filter((m) => m.folder_id === f.id).length }))],
  'POST /kb/folders': [201, (w, { body }) => {
    const name = String(body.name ?? '').trim();
    if (!name) fail(422, 'Enter a name.');
    const key = (s: string) => s.normalize('NFC').toLocaleLowerCase();
    if (w.folders.some((f) => key(f.name) === key(name))) fail(409, 'An item with this name already exists. Choose another name.');
    const folder: KbFolder = { id: `f${++w.seq}`, name, system: false, material_count: 0, created_at: stamp(w) };
    w.folders.push(folder);
    return folder;
  }],
  'PATCH /kb/folders/{folder_id}': [200, (w, { path, body }) => {
    const folder = w.folders.find((f) => f.id === path.folder_id) ?? fail(404, 'Folder not found.');
    const name = String(body.name ?? '').trim();
    const key = (s: string) => s.normalize('NFC').toLocaleLowerCase();
    if (folder.system) fail(409, 'Inbox can’t be renamed.');
    if (w.folders.some((f) => f.id !== folder.id && key(f.name) === key(name))) fail(409, 'An item with this name already exists. Choose another name.');
    folder.name = name;
    return folder;
  }],
  'DELETE /kb/folders/{folder_id}': [204, (w, { path }) => {
    const folder = w.folders.find((f) => f.id === path.folder_id) ?? fail(404, 'Folder not found.');
    if (folder.system) fail(409, 'Inbox can’t be deleted.');
    if (w.materials.some((m) => m.folder_id === folder.id)) fail(409, 'This folder still has materials. Move or delete them first.');
    w.folders = w.folders.filter((f) => f.id !== folder.id);
  }],

  // -- materials --
  'GET /kb/materials': [200, (w, { query }) => w.materials
    .filter((m) => (!query.folder_id || m.folder_id === query.folder_id) && (!query.kind || m.kind === query.kind))
    .map((m) => summaryOf(w, m))],
  'GET /kb/materials/{material_id}': [200, (w, { path }) => materialView(w, findMaterial(w, path.material_id))],
  'PATCH /kb/materials/{material_id}': [200, (w, { path, body }) => {
    const m = findMaterial(w, path.material_id);
    if (typeof body.title === 'string') {
      const title = body.title;
      if (w.materials.some((x) => x.id !== m.id && x.folder_id === m.folder_id && x.title.toLowerCase() === title.toLowerCase())) {
        fail(409, 'A material with this name is already in this folder. Choose another name.');
      }
      m.title = title;
    }
    if (typeof body.folder_id === 'string') { m.folder_id = body.folder_id; w.lastFolderId = body.folder_id; }
    return materialView(w, m);
  }],
  'DELETE /kb/materials/{material_id}': [200, (w, { path }) => {
    const m = findMaterial(w, path.material_id);
    if (m.status === 'recording') fail(409, 'This recording is still running. Stop it first.');
    w.materials = w.materials.filter((x) => x.id !== m.id);
    return deletePreview(w, m);
  }],
  'GET /kb/materials/{material_id}/delete-preview': [200, (w, { path }) => deletePreview(w, findMaterial(w, path.material_id))],
  'GET /kb/materials/{material_id}/corrections': [200, (w, { path }) => w.corrections.filter((c) => c.material_id === path.material_id)],
  'GET /kb/materials/{material_id}/excluded': [200, (w, { path }) => guardOf(w, findMaterial(w, path.material_id).id)],
  'POST /kb/materials/{material_id}/excluded/{seg}/restore': [200, (w, { path }) => {
    const m = findMaterial(w, path.material_id);
    const item = (w.excluded[m.id] ?? []).find((x) => x.seg === path.seg) ?? fail(404, 'This fragment isn’t excluded.');
    item.restored = true;
    return guardOf(w, m.id);
  }],
  'POST /kb/materials/{material_id}/ingest': [202, (w, { path }) => {
    const m = findMaterial(w, path.material_id);
    // Like ingest/service.py: a finished material without text has nothing for the wiki.
    if (m.status === 'ready' && m.fragments.length === 0) {
      fail(409, m.kind === 'recording' ? 'No speech was recognised in this recording, so there is nothing to add to the wiki.'
        : 'No speech was recognised in this file, so there is nothing to add to the wiki.');
    }
    const job = newJob(w, 'ingest', m.id, 'running', 'Adding to the wiki');
    job.step = 'checking_recognition';
    m.wiki = materialWiki('processing', { job_id: job.id });
    m.wiki_state = 'processing';
    return job;
  }],
  'POST /kb/materials/text': [201, (w, { body }) => {
    const text = String(body.text ?? '');
    const title = body.title ?? `Pasted text: ${text.split('\n')[0]!.slice(0, 40)}`;
    return added(w, newMaterial(w, title, 'text', body.folder_id, 'ready', [text]));
  }],
  'POST /kb/materials/file': [201, (w, { body }) => {
    const name = body.title ?? (body.path.split('/').pop() ?? 'File').replace(/\.[^.]+$/, '');
    return added(w, newMaterial(w, name, 'pdf', body.folder_id, 'ready', ['First page of the document.']));
  }],
  'POST /kb/materials/link': [201, (w, { body }) => {
    const info = classifyFake(body.url);
    const video = info.kind === 'video' && body.mode !== 'text';
    return added(w, newMaterial(w, body.title ?? info.title ?? info.domain, video ? 'video_link' : 'web', body.folder_id, 'processing', []));
  }],
  'POST /kb/links/classify': [200, (_w, { body }) => classifyFake(body.url)],
  'POST /kb/imports': [201, (w, { body }) => {
    const name = body.title ?? (body.url ? classifyFake(body.url).title ?? 'Video' : (body.path ?? '').split('/').pop()!.replace(/\.[^.]+$/, ''));
    const m = newMaterial(w, name, body.url ? 'video_link' : 'audio', body.folder_id ?? w.lastFolderId, 'processing', []);
    return { ...speechView(m, `s-${m.id}`, null), import_state: 'running', import_stage: 'transcribing' };
  }],

  // -- recognition fixes --
  'POST /kb/corrections/{correction_id}/revert': [200, (w, { path }) => applyCorrection(w, findCorrection(w, path.correction_id), 'revert')],
  'POST /kb/corrections/{correction_id}/accept': [200, (w, { path }) => applyCorrection(w, findCorrection(w, path.correction_id), 'accept')],
  'POST /kb/corrections/{correction_id}/keep': [200, (w, { path }) => applyCorrection(w, findCorrection(w, path.correction_id), 'keep')],
  'POST /kb/corrections/{correction_id}/reapply': [200, (w, { path }) => applyCorrection(w, findCorrection(w, path.correction_id), 'reapply')],

  // -- jobs --
  'GET /kb/jobs': [200, (w, { query }) => w.jobs.filter((j) => !query.material_id || j.material_id === query.material_id)],
  'GET /kb/jobs/{job_id}': [200, (w, { path }) => w.jobs.find((j) => j.id === path.job_id) ?? fail(404, 'Job not found.')],

  // -- wiki --
  'GET /kb/wiki/pages': [200, (w, { query }) => w.pages.filter((p) => (!query.kind || p.kind === query.kind)
    && (!query.folder_id || p.folders.includes(query.folder_id))).map(pageSummary)],
  'GET /kb/wiki/pages/{page_id}': [200, (w, { path }) => findPage(w, path.page_id)],
  'POST /kb/wiki/pages/{page_id}/blocks': [201, (w, { path, body }) => {
    const page = findPage(w, path.page_id);
    page.blocks.push(block(`u${++w.seq}`, 'user_note', body.section ?? 'My notes', body.text));
    return page;
  }],
  'PUT /kb/wiki/pages/{page_id}/blocks/{block_id}': [200, (w, { path, body }) => {
    const page = findPage(w, path.page_id);
    const b = page.blocks.find((x) => x.id === path.block_id) ?? fail(404, 'Block not found.');
    b.text = body.text;
    if (b.owner === 'agent') b.owner = 'user_edited';
    return page;
  }],
  'DELETE /kb/wiki/pages/{page_id}/blocks/{block_id}': [200, (w, { path }) => {
    const page = findPage(w, path.page_id);
    const b = page.blocks.find((x) => x.id === path.block_id) ?? fail(404, 'Block not found.');
    if (b.owner !== 'user') fail(409, 'Only your own notes can be deleted.');
    page.blocks = page.blocks.filter((x) => x !== b);
    return page;
  }],
  'POST /kb/wiki/pages/{page_id}/blocks/{block_id}/recheck': [202, (w, { path }) => {
    const page = findPage(w, path.page_id);
    const b = page.blocks.find((x) => x.id === path.block_id) ?? fail(404, 'Block not found.');
    b.owner = 'agent';
    return newJob(w, 'recheck', page.sources[0] ?? null, 'done', 'Re-checking against sources');
  }],
  'POST /kb/wiki/connections/find': [202, (w) => newJob(w, 'connections', null, 'running', 'Finding connections')],
  'GET /kb/graph': [200, (w, { query }) => {
    if (!query.folder_id) return w.graph;
    const nodes = w.graph.nodes.filter((n) => n.folder_ids.includes(query.folder_id!));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: w.graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }],

  // -- recordings --
  'GET /kb/recordings/defaults': [200, (w) => ({ folder_id: w.lastFolderId })],
  'POST /kb/recordings': [201, (w, { body }) => {
    const m = newMaterial(w, 'Recording 15 Oct, 09:00', 'recording', body.folder_id ?? w.lastFolderId, 'recording', []);
    m.translation = w.settings.native_recording_mode === 'translation'
      ? { language: String(w.settings.translation_target_language), fragments: [] } : null;
    const view = speechView(m, `s-${m.id}`, 'recording');
    w.recordings[m.id] = view;
    return view;
  }],
  'GET /kb/recordings/{material_id}': [200, (w, { path }) => findRecording(w, path.material_id).view],
  'GET /kb/recordings/{material_id}/live': [200, (w, { path, query }) => {
    const { material } = findRecording(w, path.material_id);
    // Without continuous speech the recording grows: every read closes the next sentence of the lecture.
    if (material.status === 'recording' && w.liveOpen === undefined) growLive(material);
    const last = material.fragments[material.fragments.length - 1];
    const at = last?.end_ms ?? 0;
    return {
      material_id: material.id, after_seg: last?.seg ?? 0, stream: w.liveTranscription ?? 'streaming',
      monologues: w.liveOpen ? [{ speaker: 'Speaker 1', start_ms: at, end_ms: at + 60_000, text: w.liveOpen }] : [],
      partial: { speaker: null, text: w.liveTail, translation: 'Получается, что cross-entropy в машинном обучении —' },
      // Only what was added after the fragment the caller has (the live panel appends it).
      fragments: query.since_seg === undefined || query.since_seg === null ? []
        : structuredClone(material.fragments.filter((f) => f.seg > Number(query.since_seg))),
    };
  }],
  'POST /kb/recordings/{material_id}/stop': [200, (w, { path }) => setRecording(w, path.material_id, 'ready', 'stopped')],
  'POST /kb/recordings/{material_id}/pause': [200, (w, { path }) => setRecording(w, path.material_id, 'ready', 'paused')],
  'POST /kb/recordings/{material_id}/resume': [200, (w, { path }) => setRecording(w, path.material_id, 'recording', 'recording')],

  // -- chats --
  'GET /kb/chats': [200, (w, { query }) => {
    const text = typeof query.q === 'string' ? query.q.trim() : '';
    let list = (text ? w.chats.filter((c) => chatMatches(c, text)) : w.chats).map(chatSummary);
    if (query.filter === 'pinned') list = list.filter((c) => c.pinned);
    if (query.filter === 'recording') list = list.filter((c) => c.recording_material_id);
    if (query.folder_id) list = list.filter((c) => c.folder_ids.includes(query.folder_id!));
    list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return typeof query.limit === 'number' ? list.slice(0, query.limit) : list;
  }],
  'GET /kb/chats/events': [200, (w, { query }) => ({
    chats: w.listChanges.filter((c) => c.seq > Number(query.after ?? 0)).map((c) => c.chat), cursor: w.listCursor,
  })],
  'POST /kb/chats': [201, (w, { body }) => {
    const engine = body?.engine ?? w.agents.default;
    const a = w.agents.agents.find((x) => x.id === engine);
    if (!a || a.state !== 'ready') fail(409, `${a?.name ?? 'This agent'} isn’t ready: ${a?.reason ?? 'unavailable'}`);
    const recording = body?.recording_material_id ?? null;
    const at = clock(w, ++w.seq);
    const c: KbChat = {
      id: `c${w.seq}`, title: body?.title ?? (recording ? w.materials.find((m) => m.id === recording)?.title ?? 'Recording' : 'New chat'),
      pinned: false, engine: a!.id, model: body?.model ?? a!.current_model, effort: body?.effort ?? 'medium', created_at: at, updated_at: at,
      last_preview: '', recording_material_id: recording, folder_ids: [], state: 'idle', unread: false, messages: [], cursor: 0,
    };
    w.chats.push(c);
    w.chatEvents[c.id] = [];
    touchList(w, c);
    return structuredClone(c);
  }],
  'GET /kb/chats/{chat_id}': [200, (w, { path }) => structuredClone(findChat(w, path.chat_id))],
  'PATCH /kb/chats/{chat_id}': [200, (w, { path, body }) => {
    const c = findChat(w, path.chat_id);
    if (typeof body.title === 'string') c.title = body.title;
    if (typeof body.pinned === 'boolean') c.pinned = body.pinned;
    if (body.engine && body.engine !== c.engine) {
      const a = w.agents.agents.find((x) => x.id === body.engine);
      if (!a || a.state !== 'ready') fail(409, `${a?.name ?? 'This agent'} can’t answer now: ${a?.reason ?? 'unavailable'}`);
      c.engine = a!.id;
      c.model = body.model ?? a!.current_model;
      const sys = chatMessage(`${c.id}-s${++w.seq}`, (c.messages.at(-1)?.seq ?? 0) + 1, 'system', clock(w), [{ type: 'text', text: `Switched to ${a!.name}` }], { engine: a!.id });
      c.messages.push(sys);
      pushEvent(w, c.id, { type: 'message', message_id: sys.id, message: structuredClone(sys) });
    } else if (typeof body.model === 'string') c.model = body.model;
    if (typeof body.effort === 'string') c.effort = body.effort;
    touchList(w, c);
    return chatSummary(c);
  }],
  'DELETE /kb/chats/{chat_id}': [204, (w, { path }) => {
    findChat(w, path.chat_id);
    w.chats = w.chats.filter((x) => x.id !== path.chat_id);
  }],
  'GET /kb/chats/{chat_id}/events': [200, (w, { path, query }) => {
    const c = findChat(w, path.chat_id);
    return { events: (w.chatEvents[c.id] ?? []).filter((e) => e.seq > Number(query.after ?? 0)), cursor: c.cursor };
  }],
  'POST /kb/chats/{chat_id}/messages': [202, (w, { path, body }) => {
    const c = findChat(w, path.chat_id);
    if (c.state === 'answering') fail(409, 'The agent is still answering in this chat.');
    const user = chatMessage(`${c.id}-u${++w.seq}`, (c.messages.at(-1)?.seq ?? 0) + 1, 'user', clock(w), [{ type: 'text', text: body.text }], {
      input: { text: body.text, mentions: body.mentions ?? [], quotes: body.quotes ?? [], attachments: body.attachments ?? [] },
    });
    c.messages.push(user);
    pushEvent(w, c.id, { type: 'message', message_id: user.id, message: structuredClone(user) });
    if (c.title === 'New chat') {
      c.title = body.text.slice(0, 40) || 'New chat';
      pushEvent(w, c.id, { type: 'title', message_id: null, text: c.title });
    }
    const assistant = startAnswer(w, c, body.text);
    touchList(w, c);
    return { user: structuredClone(user), assistant: structuredClone(c.messages.find((x) => x.id === assistant.id)!) };
  }],
  'POST /kb/chats/{chat_id}/messages/{message_id}/stop': [200, (w, { path }) => {
    const c = findChat(w, path.chat_id);
    const msg = findMessage(c, path.message_id);
    delete w.pendingAnswers[c.id];
    emit(w, c, [{ type: 'state', message_id: msg.id, message: { ...structuredClone(msg), state: 'cancelled' } }]);
    c.state = 'idle';
    touchList(w, c);
    return structuredClone(msg);
  }],
  'POST /kb/chats/{chat_id}/messages/{message_id}/regenerate': [202, (w, { path }) => answerAgain(w, path.chat_id, path.message_id, false)],
  'POST /kb/chats/{chat_id}/messages/{message_id}/resume': [202, (w, { path }) => answerAgain(w, path.chat_id, path.message_id, true)],
  'POST /kb/chats/{chat_id}/messages/{message_id}/save': [200, (w, { path }) => {
    const c = findChat(w, path.chat_id);
    const msg = findMessage(c, path.message_id);
    if (msg.saved_page_id) fail(409, 'This answer is already saved to the wiki.');
    msg.saved_page_id = `p-${msg.id}`;
    emit(w, c, [{ type: 'message', message_id: msg.id, message: structuredClone(msg) }]);
    return { id: msg.saved_page_id, kind: 'analysis', title: c.title };
  }],
  'POST /kb/chats/{chat_id}/save': [200, (w, { path }) => {
    const c = findChat(w, path.chat_id);
    return { id: `p-${c.id}`, kind: 'analysis', title: c.title };
  }],
  'GET /kb/chats/{chat_id}/export': [200, (w, { path }) => {
    const c = findChat(w, path.chat_id);
    return { file_name: `${c.title}.md`, markdown: `# ${c.title}\n\n${c.messages.map((x) => x.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).join('\n\n')}` };
  }],
  'POST /kb/chats/{chat_id}/read': [204, (w, { path }) => {
    const c = findChat(w, path.chat_id);
    c.unread = false;
    touchList(w, c);
  }],
  'GET /kb/mentions': [200, (w, { query }) => {
    // Like the backend: every word of the query is in the title, in any order.
    const words = String(query.q ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const has = (t: string) => words.every((w) => t.toLocaleLowerCase().includes(w));
    return {
      pages: w.pages.filter((p) => has(p.title)).map(pageRef),
      materials: w.materials.filter((m) => has(m.title)).map((m): KbRef => ({ type: 'material', id: m.id, title: m.title })),
      chats: w.chats.filter((c) => has(c.title)).map((c): KbRef => ({ type: 'chat', id: c.id, title: c.title })),
    };
  }],

  // -- notifications --
  'GET /kb/notifications': [200, (w, { query }) => {
    const after = Number(query.after ?? 0);
    const items = w.notifications.filter((n) => n.seq > after && (query.include_dismissed === true || !n.dismissed_at));
    const live = w.notifications.filter((n) => !n.dismissed_at);
    return {
      items: [...items].sort((a, b) => b.seq - a.seq),
      cursor: w.notificationSeq,
      unread: live.filter((n) => n.seq > w.readUpTo).length,
      requires_action: live.filter((n) => n.requires_action && !n.resolved_at).length,
    };
  }],
  'POST /kb/notifications/read': [204, (w, { body }) => { w.readUpTo = Math.max(w.readUpTo, body.up_to_seq); }],
  'POST /kb/notifications/{notification_id}/dismiss': [200, (w, { path }) => {
    const n = findNotification(w, path.notification_id);
    n.dismissed_at = stamp(w);
    bump(w, n);
    return structuredClone(n);
  }],
  'POST /kb/notifications/{notification_id}/resolve': [200, (w, { path, body }) => {
    const n = findNotification(w, path.notification_id);
    if (n.resolved_at) fail(409, 'Already decided.');
    const action = n.actions.find((a) => a.id === body.action) ?? fail(422, 'Unknown action.');
    if (action.needs_text && !String(body.text ?? '').trim()) fail(422, 'Enter the text first.');
    // Like link_failures.handle: "Delete" removes the failed material.
    const subject = (n.payload as { material_id?: string }).material_id;
    if (action.id === 'delete_material' && subject) w.materials = w.materials.filter((m) => m.id !== subject);
    n.resolved_at = stamp(w);
    n.resolution = action.id;
    bump(w, n);
    return structuredClone(n);
  }],

  // -- search --
  'GET /kb/search': [200, (w, { query }) => search(w, String(query.q ?? ''))],

  // -- settings --
  'GET /kb/settings/health': [200, (w) => structuredClone(w.health)],
  'POST /kb/settings/health/{problem_id}/{action_id}': [200, (w, { path }) => {
    if (path.problem_id === 'speech-soniox-consent') {
      // Only the user's click gives the consent; "Recognise on this Mac" switches the service instead.
      if (path.action_id === 'allow_soniox') w.speech.cloud_consent = true;
      else if (path.action_id === 'use_local') w.speech.provider = 'local_whisper';
      syncSpeechConsent(w);
    }
    for (const s of w.health.sections) {
      s.problems = s.problems.filter((p) => p.id !== path.problem_id);
      if (!s.problems.length) s.state = 'ok';
    }
    return structuredClone(w.health);
  }],
  'GET /kb/settings/keys': [200, (w) => structuredClone(w.keys)],
  'PUT /kb/settings/keys/{provider}': [200, (w, { path, body }) => {
    const p = w.keys.providers.find((x) => x.id === path.provider) ?? fail(404, 'Unknown provider.');
    p.configured = body.key.length > 0;
    p.valid = null;
    p.checked_at = null;
    return structuredClone(p);
  }],
  'POST /kb/settings/keys/{provider}/check': [200, (w, { path }) => {
    const p = w.keys.providers.find((x) => x.id === path.provider) ?? fail(404, 'Unknown provider.');
    p.checked_at = stamp(w);
    p.valid = p.configured;
    return structuredClone(p);
  }],
  'GET /kb/settings/speech': [200, (w) => structuredClone(w.speech)],
  'PUT /kb/settings/speech': [200, (w, { body }) => {
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) (w.speech as unknown as Record<string, unknown>)[k] = v;
    syncSpeechConsent(w);
    return structuredClone(w.speech);
  }],
  'DELETE /kb/settings/speech/local-model': [200, (w) => {
    const model = w.speech.local_model;
    const deleted = model.state === 'ready' || model.state === 'failed';
    const freed = deleted ? model.size_bytes ?? 0 : 0;
    w.speech.local_model = { ...model, state: 'missing', progress: null, reason: null };
    return { deleted, deleted_bytes: freed, speech: structuredClone(w.speech) };
  }],
  'GET /kb/settings/privacy': [200, (w) => structuredClone(w.privacy)],
  'GET /kb/settings/about': [200, (w) => structuredClone(w.about)],
  'GET /kb/settings/wiki': [200, (w) => structuredClone(w.wiki)],
  'PUT /kb/settings/wiki': [200, (w, { body }) => {
    for (const [k, v] of Object.entries(body)) if (v !== undefined && k !== 'wiki_engine') (w.wiki as unknown as Record<string, unknown>)[k] = v;
    if ('wiki_engine' in body) w.wiki.wiki_engine = body.wiki_engine ?? null;
    if (body.wiki_language) w.wiki.wiki_language_chosen = true;
    return structuredClone(w.wiki);
  }],
  'GET /kb/decisions': [200, (w) => structuredClone(w.decisions)],
  'PUT /kb/decisions/provider': [200, (w, { body }) => {
    if (body.provider === 'openrouter_jev' && body.cloud_consent !== true && !w.decisions.cloud_consent) {
      fail(409, 'Confirm that short excerpts may go to OpenRouter.');
    }
    w.decisions.provider = body.provider;
    if (body.cloud_consent === true) w.decisions.cloud_consent = true;
    return structuredClone(w.decisions);
  }],
  'POST /kb/decisions/local/download': [202, (w) => {
    w.decisions.local.state = 'downloading';
    w.decisions.local.progress = 0.12;
    return structuredClone(w.decisions);
  }],
  'POST /kb/decisions/local/cancel': [200, (w) => {
    w.decisions.local.state = 'not_downloaded';
    w.decisions.local.progress = null;
    return structuredClone(w.decisions);
  }],

  // -- agents --
  'GET /kb/agents': [200, (w) => structuredClone(w.agents)],
  'PUT /kb/agents/default': [200, (w, { body }) => { w.agents.default = body.engine; return structuredClone(w.agents); }],
  'POST /kb/agents/{engine}/check': [200, (w, { path }) => {
    const a = findAgent(w, path.engine);
    a.checked_at = stamp(w);
    return structuredClone(a);
  }],
  'POST /kb/agents/{engine}/login': [200, (w, { path, body }) => {
    const a = findAgent(w, path.engine);
    if (a.id === 'codex' && body?.consent !== true) fail(409, 'Confirm the ChatGPT privacy notice first.');
    Object.assign(a, { state: 'ready', signed_in: true, reason: null, action: null });
    return { engine: a.id, method: 'terminal', url: null, message: `${a.name} sign-in opened in Terminal. Come back when it says you’re signed in.` };
  }],
  'POST /kb/agents/codex/logout': [200, (w) => {
    const a = findAgent(w, 'codex');
    Object.assign(a, { state: 'signed_out', signed_in: false, reason: 'Sign in with ChatGPT to use Codex.', action: 'login', models: [], current_model: null });
    return structuredClone(a);
  }],
  'POST /kb/agents/{engine}/install': [202, (w, { path, body }) => {
    const a = findAgent(w, path.engine);
    const action = body?.action ?? (a.state === 'outdated' ? 'update' : 'install');
    const task: KbInstallTask = {
      id: `t${++w.seq}`, engine: a.id, action, state: 'running',
      lines: [{ seq: 1, text: action === 'first_check' ? `Checking ${a.name}…` : `Downloading ${a.name}…`, at: stamp(w) }], cursor: 1, dropped: 0,
      reason: null, version: null, install: a.install, started_at: stamp(w), finished_at: null,
    };
    w.installTasks[task.id] = task;
    a.install_task = task.id;
    return structuredClone(task);
  }],
  'GET /kb/agents/install/{task_id}': [200, (w, { path, query }) => {
    const task = w.installTasks[path.task_id] ?? fail(404, 'Install task not found.');
    return { ...structuredClone(task), lines: task.lines.filter((l) => l.seq > Number(query.after ?? 0)) };
  }],
  'POST /kb/agents/install/{task_id}/cancel': [200, (w, { path }) => {
    const task = w.installTasks[path.task_id] ?? fail(404, 'Install task not found.');
    task.state = 'cancelled';
    task.finished_at = stamp(w);
    return structuredClone(task);
  }],
};

function findCorrection(w: FakeWorld, id: string): KbCorrection {
  return w.corrections.find((c) => c.id === id) ?? fail(404, 'Correction not found.');
}

function findPage(w: FakeWorld, id: string): KbPage {
  return w.pages.find((p) => p.id === id) ?? fail(404, 'Page not found.');
}

function findMessage(c: KbChat, id: string): KbMessage {
  return c.messages.find((m) => m.id === id) ?? fail(404, 'Message not found.');
}

function findNotification(w: FakeWorld, id: string): KbNotification {
  return w.notifications.find((n) => n.id === id) ?? fail(404, 'Notification not found.');
}

function findAgent(w: FakeWorld, id: string) {
  return w.agents.agents.find((a) => a.id === id) ?? fail(404, 'Unknown agent.');
}

function findRecording(w: FakeWorld, id: string) {
  const view = w.recordings[id];
  const m = w.materials.find((x) => x.id === id);
  if (!view || !m) fail(404, 'This material is not a recording.');
  return { view: view!, material: m! };
}

function setRecording(w: FakeWorld, id: string, status: KbMaterial['status'], state: KbSpeechMaterial['recording_state']): KbSpeechMaterial {
  const { view, material } = findRecording(w, id);
  material.status = status;
  view.status = status;
  view.recording_state = state;
  return view;
}

function answerAgain(w: FakeWorld, chatId: string, messageId: string, resume: boolean) {
  const c = findChat(w, chatId);
  const msg = findMessage(c, messageId);
  if (resume && msg.state !== 'interrupted') fail(409, 'This answer wasn’t interrupted.');
  const idx = c.messages.indexOf(msg);
  const question = [...c.messages.slice(0, idx)].reverse().find((x) => x.role === 'user');
  const answer = startAnswer(w, c, resume ? '' : (question?.input?.text ?? ''));
  touchList(w, c);
  return { user: structuredClone(question ?? msg), assistant: structuredClone(c.messages.find((x) => x.id === answer.id)!) };
}

// ---- Old routes the recording reuses (not part of /kb) ----------------------------------------

const LIVE_LINES = [
  ['So Boltzmann wrote the entropy as S equals k times the log of W.', 'Итак, Больцман записал энтропию как S равно k логарифм W.'],
  ['Why a logarithm? So that entropies of two independent systems add up.', 'Почему логарифм? Чтобы энтропии двух независимых систем складывались.'],
  ['Is it the same log as in information theory?', 'Это тот же логарифм, что в теории информации?'],
  ['Exactly. Shannon took the same form — the same entropy, just for messages.', 'Именно. Шеннон взял ту же форму — та же энтропия, только для сообщений.'],
] as const;

function growLive(m: KbMaterial) {
  const i = m.fragments.length;
  if (i >= LIVE_LINES.length) return;
  const [en, ru] = LIVE_LINES[i]!;
  const at = Math.round((8.2 + i * 1.5) * 60_000);
  m.fragments.push(fragment(m.id, i + 1, en, { start_ms: at, end_ms: at + 12_000, speaker: i === 2 ? 'Speaker 2' : 'Speaker 1' }));
  m.translation?.fragments.push({ seg: i + 1, speaker: null, text: ru });
  m.fragment_count = m.fragments.length;
}

function serveLegacy(w: FakeWorld, req: BridgeRequest): unknown {
  const { method, path } = req;
  if (method === 'GET' && path === '/settings') return w.settings;
  if (method === 'PUT' && path === '/settings') { Object.assign(w.settings, req.body); return w.settings; }
  if (method === 'GET' && path === '/logs') return w.activity ?? { entries: [], capacity: 256, dropped: 0 };
  const m = /^\/sessions\/([^/]+)\/live$/.exec(path);
  if (m && method === 'GET') return { session_id: m[1], sample_rate: 48000, saved_samples: 0, next_sequence: 0, transcription: 'inactive', connections: [], gaps: [] };
  return undefined;
}

// ---- The router -----------------------------------------------------------------------------

interface Compiled { method: string; pattern: RegExp; names: string[]; entry: Entry<KbRoute> }

const COMPILED: Compiled[] = (Object.entries(ROUTES) as Array<[KbRoute, Entry<KbRoute>]>).map(([route, entry]) => {
  const space = route.indexOf(' ');
  const names: string[] = [];
  const source = route.slice(space + 1).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method: route.slice(0, space), pattern: new RegExp(`^${source}$`), names, entry };
});

/** Routes the fake answers (for the IPC-policy test: each one is a real backend route). */
export const FAKE_ROUTES = Object.keys(ROUTES) as KbRoute[];

/** Routes that need a connected library, like the backend's 503. */
const NEEDS_LIBRARY = /^\/kb\/(folders|materials|notifications|chats|search|mentions|imports|wiki|graph|jobs|recordings|links|corrections)(\/|$)/;

const ok = <T,>(data: T, status = 200): JsonResponse<T> => ({ ok: true, status, data });
const failed = (status: number, detail: string): JsonResponse<never> => ({ ok: false, status, detail });

/**
 * Serve one bridge request from the world. Unknown routes answer `null`: the caller decides
 * (fakeBridge answers like the IPC policy, the smokes record them).
 */
export function serveFake(world: FakeWorld, req: BridgeRequest): JsonResponse<unknown> | null {
  const { method, path } = req;
  world.log.push({ method, path, body: req.body });
  const forced = world.failures[`${method} ${path}`];
  if (forced) {
    delete world.failures[`${method} ${path}`];
    return failed(forced.status, forced.detail);
  }
  if (world.missing?.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return failed(404, 'Not Found');
  if (!path.startsWith('/kb/')) {
    const legacy = serveLegacy(world, req);
    return legacy === undefined ? null : ok(legacy);
  }
  if (NEEDS_LIBRARY.test(path) && world.library.state !== 'ready') {
    return failed(503, 'The library is not connected. Choose where to keep it.');
  }
  for (const route of COMPILED) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string | number> = {};
    route.names.forEach((name, i) => {
      const value = decodeURIComponent(match[i + 1]!);
      params[name] = name === 'seg' ? Number(value) : value;
    });
    const [status, handle] = route.entry;
    try {
      const data = handle(world, { path: params as never, query: (req.query ?? {}) as never, body: (req.body ?? {}) as never });
      return ok(data === undefined ? null : data, status);
    } catch (error) {
      if (error instanceof FakeHttpError) return failed(error.status, error.detail);
      throw error;
    }
  }
  return null;
}

/** The fake `bridge.dictate` (main → POST /kb/dictation). */
export function fakeDictate(world: FakeWorld) {
  return async (wav: ArrayBuffer, language?: string): Promise<JsonResponse<KbDictation>> => {
    void wav;
    if ('status' in world.dictation) return failed(world.dictation.status, world.dictation.detail);
    return ok({ text: world.dictation.text, language: language ?? 'en', provider: 'soniox' });
  };
}

/** Native audio stand-in: acknowledges PCM exactly as main does (sequence + sample clock). */
export function fakeNative() {
  const sessions = new Map<string, { rate: number; samples: number; next: number }>();
  const failures = new Set<(f: { sessionId: string; code: 'transcription_failed'; reason?: string }) => void>();
  return {
    sessions,
    fail(sessionId: string, reason: string) { for (const l of failures) l({ sessionId, code: 'transcription_failed', reason }); },
    openNative: async (sessionId: string, sampleRate: number): Promise<JsonResponse<NativeOpened>> => {
      const s = sessions.get(sessionId) ?? { rate: sampleRate, samples: 0, next: 0 };
      sessions.set(sessionId, s);
      return ok({ connection_id: `c-${sessionId}`, sample_rate: s.rate, saved_samples: s.samples, next_sequence: s.next, transcription: 'connecting', audio_retained: true });
    },
    sendNativeAudio: async (sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<JsonResponse<NativeSaved>> => {
      const s = sessions.get(sessionId);
      if (!s || meta.sequence !== s.next || meta.startSample !== s.samples) return failed(409, 'Out of order.');
      s.samples += pcm.byteLength / 2;
      s.next += 1;
      return ok({ sequence: meta.sequence, saved_samples: s.samples, duplicate: false });
    },
    endNative: async (sessionId: string, action: 'pause' | 'stop'): Promise<JsonResponse<NativeStopped>> => {
      const s = sessions.get(sessionId);
      return ok({ saved_samples: s?.samples ?? 0, transcription_complete: true, status: action === 'pause' ? 'paused' : 'stopped' });
    },
    onNativeFailure: (listener: (f: { sessionId: string; code: 'transcription_failed'; reason?: string }) => void) => {
      failures.add(listener);
      return () => { failures.delete(listener); };
    },
  };
}
