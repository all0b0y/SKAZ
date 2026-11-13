import { vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../../api/bridge';
import type {
  KbArea, KbAreaMap, KbAreaMaterial, KbFinding, KbFunnelCandidate, KbFunnelRun, KbSearch, KbSearchPlan, KbSearchPlanRequest,
  KbTopicLabelling, KbWeeklyCheck, KbWeeklySettings,
} from '../../../api/kb/types.gen';
import { createFakeKb } from '../../api/fake';
import { contractFixtures as f } from '../../api/fake/fixtures';
import { KbClient } from '../../api/client';
import { createServices } from '../../state/context';
import { createExploreClients } from '../types';

export const topic = (id: string, name: string, materials: number, extra: Partial<KbArea> = {}): KbArea => ({
  ...f.KbArea, id, name, original_name: name, parent_id: null, level: 'custom', taxonomy_id: null,
  topic_ids: [], hidden: false, pinned: false, materials, pages: materials * 12, sources: materials,
  wiki_share: materials / 93, has_children: false, depth: materials ? 'medium' : 'empty', gap_reason: null,
  ...extra,
});
export const roots = [topic('ai', 'AI agents', 60, { has_children: true }), topic('ml', 'ML', 25),
  topic('business', 'Business communication', 6), topic('tiny-a', 'Mechanics', 1), topic('tiny-b', 'Writing', 1)];
export const children = [topic('agents', 'Agent harnesses', 40, { parent_id: 'ai' }), topic('attention', 'Attention', 20, { parent_id: 'ai' })];
export const mapFixture = (extra: Partial<KbAreaMap> = {}): KbAreaMap => ({
  ...f.KbAreaMap, parent_id: null, breadcrumbs: [], areas: roots, total_pages: 1124, total_sources: 93,
  worth_closing: [], unsorted_materials: 0,
  labelling: { state: 'idle', job_id: null, done: 93, total: 93, reason_code: null, engine: null }, ...extra,
});
export const runFixture = (extra: Partial<KbFunnelRun> = {}): KbFunnelRun => ({
  ...f.KbFunnelRun, id: 'ex2-run', area_id: null, task_id: null, state: 'done', stage: 'ready',
  stop_reason: 'completed', query: '', plan: [{ area_id: 'ai', label: 'AI agents', terms: ['AI agents', 'Harness'] }],
  counters: { checked: 50, after_rules: 40, decided: 40, on_topic: 12, novelty_checked: 12, new: 4, covered: 8 }, ...extra,
});
export const candidate = (id: string, outcome: KbFunnelCandidate['outcome'], reason: string): KbFunnelCandidate => ({
  ...f.KbFunnelCandidate, candidate_id: id, work: { ...f.KbScienceWork, id, title: `Work ${id}`, abstract: `Abstract for ${id}` },
  outcome, reason, overridden: false,
});

export function ex2Kb() {
  const kb = createFakeKb('home');
  kb.areas.map = vi.fn(async (query = {}) => query.parent_id === 'ai'
    ? mapFixture({ parent_id: 'ai', breadcrumbs: [roots[0]!], areas: children }) : mapFixture());
  kb.areas.opened = vi.fn(async () => ({ ok: true as const }));
  kb.areas.materials = vi.fn(async () => ({ ...f.KbAreaMaterials, materials: [{ ...f.KbAreaMaterials.materials[0]!, title: 'Local meeting notes', material_id: 'meeting' }], next_cursor: null }));
  kb.areas.update = vi.fn(async (id, body) => ({ ...[...roots, ...children].find((a) => a.id === id)!, ...body } as KbArea));
  kb.areas.create = vi.fn(async (body) => topic('created', body.name, 0, { parent_id: body.parent_id ?? null }));
  kb.explore.jobs = vi.fn(async () => ({ jobs: [] }));
  kb.explore.run = vi.fn(async () => runFixture());
  kb.explore.findings = vi.fn(async () => ({ ...f.KbFindings, groups: [], covered_count: 0, next_cursor: null, full_text_key_hint_count: 0 }));
  kb.explore.start = vi.fn(async () => runFixture({ state: 'running', stage: 'collect' }));
  const topics = {
    sort: vi.fn(async () => ({ state: 'running' as const, job_id: 'sort-1', done: 0, total: 93, engine: 'codex', reason_code: null })),
    merge: vi.fn(async (_id: string, intoId: string) => [...roots, ...children].find((a) => a.id === intoId)!),
    move: vi.fn(async (materialId: string, areaId: string) => ({ material_id: materialId, area_id: areaId, origin: 'user' as const })),
  };
  const discovery = {
    plan: vi.fn(async (body: KbSearchPlanRequest): Promise<KbSearchPlan> => ({ ready: true, reason: null, items: body.query?.trim()
      ? [{ area_id: body.area_id ?? null, label: body.query.trim(), terms: [body.query.trim()] }]
      : (body.area_id ? [...roots, ...children].filter((a) => a.id === body.area_id) : roots.slice(0, 3))
        .map((a) => ({ area_id: a.id, label: a.name, terms: [a.name, 'Harness'] })) })),
    concepts: vi.fn(async (_query: string) => [{ id: 'concept-harness', title: 'Harness evaluation', kind: 'concept' as const, matched_alias: null }]),
    candidates: vi.fn(async (_id: string, _query: { cursor?: string; outcome?: KbFunnelCandidate['outcome'] } = {}) => ({ items: [
      candidate('rules', 'dropped_by_rules', 'Outside your date rules'), candidate('no-fit', 'not_fit', 'Does not fit the search topics'),
      candidate('known', 'covered', 'Already in your wiki: Agent evaluation'),
    ], next_cursor: null as string | null })),
    fits: vi.fn(async (_runId: string, id: string) => ({ ...candidate(id, 'fits', 'You marked it as fitting'), overridden: true })),
  };
  return { ...kb, areas: { ...kb.areas, map: vi.mocked(kb.areas.map) }, topics, discovery };
}


// ---- EX3 (Explore v2): a small world behind the bridge --------------------------------------------------
// The real clients (createExploreClients) run over a fake bridge that answers the Explore routes from
// this in-memory world, so a test sees exactly which route, query and body the screen sent. A fake on the
// external seam only: it shows the screen's handling of contract-shaped answers, not the backend's.

const clone = <T,>(value: T): T => structuredClone(value);

/** An own topic as the map reads it: its size is the concepts it gives the wiki. */
export const wikiArea = (id: string, name: string, concepts: number, materials: number, extra: Partial<KbArea> = {}): KbArea => ({
  ...f.KbArea, id, name, original_name: name, parent_id: null, taxonomy_id: null, level: 'custom', topic_ids: [], hidden: false,
  pinned: false, has_children: false, children_covered: 0, children_total: 0, pages: concepts, concepts, top_concepts: [],
  sources: materials, materials, new_findings: 0, marked_materials: 0, wiki_share: concepts / 1432, depth: 'dense', gap_reason: null,
  ...extra,
});

export const searchFixture = (id: string, name: string, extra: Partial<KbSearch> = {}): KbSearch => ({
  ...f.KbSearch, id, name, owner: 'explore', area_id: null, query: '', state: 'done', stage: 'ready', stop_reason: null,
  checkpoint_id: null, checkpoint_revision: null, found: 50, fit: 12, new: 4, no_text: 2, unseen: 3, ...extra,
});

export const findingFixture = (id: string, title: string, extra: Partial<KbFinding> = {}, work: Partial<KbFinding['work']> = {}): KbFinding => ({
  ...f.KbFinding, id, run_id: 'run-1', task_id: null, area_id: null, label: 'new', wiki_refs: [], material_id: null,
  state: 'new', access: 'open', read_url: `https://arxiv.org/html/${id}`, new_line: 'It fixes a gap in how experts are balanced',
  has_abstract: true, discuss_chat_id: null,
  work: { ...f.KbScienceWork, id: `work-${id}`, title, authors: ['Ada Lovelace', 'Alan Turing'], venue: 'Fixture Journal',
    abstract: `Abstract of ${title}.`, publication_type: 'article', publication: { ...f.KbScienceWork.publication, year: 2026 }, ...work },
  ...extra,
});

export interface ExploreWorld {
  areas: KbArea[];
  materials: Record<string, KbAreaMaterial[]>;
  searches: KbSearch[];
  findings: KbFinding[];
  weekly: KbWeeklySettings;
  weeklyCheck: KbWeeklyCheck;
  unsorted: number;
  labelling: KbTopicLabelling;
  parallelLimit: number;
  /** `METHOD /path` → the failure to answer instead of the route (a call that goes wrong). */
  failing: Record<string, { status: number; detail: string; code?: string }>;
}

const material = (id: string, title: string, concepts: number): KbAreaMaterial => ({ ...f.KbAreaMaterials.materials[0]!, material_id: id, title, concepts });

/** The wiki of the prototype in small: six topics, one with subtopics and a leaf with materials. */
export function exploreWorld(over: Partial<ExploreWorld> = {}): ExploreWorld {
  return {
    areas: [
      wikiArea('ml', 'Machine learning', 457, 19, { top_concepts: ['Gradient descent', 'Regularization'] }),
      wikiArea('agents', 'AI agents', 249, 24),
      wikiArea('biz', 'Business communication', 270, 6),
      wikiArea('sus', 'Sustainable business', 218, 6),
      wikiArea('llm', 'LLM systems', 174, 34, { has_children: true, new_findings: 47, top_concepts: ['KV cache', 'Attention'] }),
      wikiArea('data', 'Data engineering', 119, 4),
      wikiArea('arch', 'Model architectures', 34, 4, { parent_id: 'llm', top_concepts: ['Mixture of Experts (MoE)'] }),
      wikiArea('inf', 'Inference optimization', 60, 9, { parent_id: 'llm' }),
    ],
    materials: { arch: [material('m-gpt', 'Transformer и GPT', 16), material('m-moe', 'MoE — смесь экспертов', 8), material('m-dense', 'Dense models', 6)] },
    searches: [], findings: [], unsorted: 0, parallelLimit: 3, failing: {},
    labelling: { ...f.KbTopicLabelling, state: 'idle', job_id: null, done: 93, total: 93, reason_code: null, engine: null },
    weekly: { ...f.KbWeeklySettings, enabled: true, latest_check_id: null, candidates_waiting: 0, next_due_at: '2026-11-16T12:00:00Z' },
    weeklyCheck: { ...f.KbWeeklyCheck, id: 'check-1', candidate_ids: [] },
    ...over,
  };
}

const ok = <T,>(data: T): JsonResponse<T> => ({ ok: true, status: 200, data: clone(data) });
const unseenOf = (world: ExploreWorld, runId: string): number => world.findings.filter((x) => x.run_id === runId && x.state === 'new').length;

/** Answers the Explore routes from the world; any other route is refused like the IPC policy refuses it. */
export function serveExplore(world: ExploreWorld, req: BridgeRequest): JsonResponse<unknown> {
  const { method, path } = req;
  const query = (req.query ?? {}) as Record<string, string | number | boolean | undefined>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const failure = world.failing[`${method} ${path}`];
  if (failure) return { ok: false, ...failure };

  if (method === 'GET' && path === '/kb/explore/searches') return ok({ items: world.searches, parallel_limit: world.parallelLimit });
  if (method === 'GET' && path === '/kb/explore/map') {
    const parent = (query.parent_id as string | undefined) ?? null;
    const trail: KbArea[] = [];
    for (let id = parent; id;) {
      const a = world.areas.find((x) => x.id === id);
      if (!a) break;
      trail.unshift(a);
      id = a.parent_id;
    }
    return ok<KbAreaMap>({
      parent_id: parent, breadcrumbs: trail, areas: world.areas.filter((a) => a.parent_id === parent), worth_closing: [],
      total_pages: 1432, total_sources: 93, unsorted_materials: world.unsorted, labelling: world.labelling,
    });
  }
  let m = /^\/kb\/explore\/areas\/([^/]+)\/materials$/.exec(path);
  if (method === 'GET' && m) return ok({ materials: world.materials[m[1]!] ?? [], not_checked_count: 0, next_cursor: null });
  if (method === 'POST' && /^\/kb\/explore\/areas\/[^/]+\/opened$/.test(path)) return ok(f.KbAcknowledged);
  m = /^\/kb\/explore\/areas\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && m) {
    const area = world.areas.find((a) => a.id === m![1]);
    if (!area) return { ok: false, status: 404, detail: 'No such topic.' };
    Object.assign(area, body);
    return ok(area);
  }
  m = /^\/kb\/explore\/areas\/([^/]+)\/merge$/.exec(path);
  if (method === 'POST' && m) {
    const into = world.areas.find((a) => a.id === body.into_id);
    if (!into) return { ok: false, status: 404, detail: 'No such topic.' };
    world.areas = world.areas.filter((a) => a.id !== m![1]).map((a) => (a.parent_id === m![1] ? { ...a, parent_id: into.id } : a));
    return ok(into);
  }
  if (method === 'POST' && path === '/kb/explore/topics/sort') return ok({ ...f.KbTopicLabelling, state: 'running', job_id: 'sort-1', done: 0, total: 93 });
  if (method === 'GET' && path === '/kb/settings/weekly-check') return ok(world.weekly);
  if (method === 'GET' && /^\/kb\/freshness\/weekly-checks\/[^/]+$/.test(path)) return ok(world.weeklyCheck);

  if (method === 'GET' && path === '/kb/explore/findings') {
    const show = (query.show as string | undefined) ?? 'active';
    const wanted = (x: KbFinding) => (show === 'active' ? x.state === 'new' || x.state === 'seen' : x.state === show);
    const list = world.findings.filter((x) => x.run_id === query.run_id && wanted(x) && !(query.free_only && x.access === 'paid'));
    return ok({ groups: [{ task_id: null, task_title: null, task_state: null, updated_at: null, findings: list }], covered_count: 0, next_cursor: null, checked_at: null, full_text_key_hint_count: 0 });
  }
  m = /^\/kb\/explore\/findings\/([^/]+)\/(seen|dismiss|restore|materials|discuss)$/.exec(path);
  if (method === 'POST' && m) {
    const finding = world.findings.find((x) => x.id === m![1]);
    if (!finding) return { ok: false, status: 404, detail: 'No such paper.' };
    const action = m[2]!;
    if (action === 'seen' && finding.state === 'new') finding.state = 'seen';
    if (action === 'dismiss') finding.state = 'dismissed';
    if (action === 'restore') finding.state = 'seen';
    const search = world.searches.find((s) => s.id === finding.run_id);
    if (search) search.unseen = unseenOf(world, search.id);
    if (action === 'materials') {
      finding.state = 'materials';
      finding.material_id = 'material-added';
      return ok({ finding_id: finding.id, material_id: 'material-added', content: 'abstract_only', to_wiki: false });
    }
    if (action === 'discuss') {
      finding.discuss_chat_id = 'chat-discuss';
      return ok({ finding_id: finding.id, chat_id: 'chat-discuss' });
    }
    return ok(finding);
  }

  m = /^\/kb\/explore\/searches\/([^/]+)\/name$/.exec(path);
  if (method === 'PUT' && m) {
    const search = world.searches.find((s) => s.id === m![1]);
    if (!search) return { ok: false, status: 404, detail: 'No such search.' };
    search.name = String(body.name);
    return ok(search);
  }
  m = /^\/kb\/explore\/searches\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && m) {
    world.searches = world.searches.filter((s) => s.id !== m![1]);
    return ok(f.KbAcknowledged);
  }
  if (method === 'POST' && path === '/kb/explore/runs') {
    const area = world.areas.find((a) => a.id === body.area_id);
    const search = searchFixture(`run-${world.searches.length + 1}`, String(body.query || area?.name || 'All your topics'), {
      area_id: (body.area_id as string | null | undefined) ?? null, query: String(body.query ?? ''), state: 'running', stage: 'collect',
      found: 0, fit: 0, new: 0, no_text: 0, unseen: 0,
    });
    world.searches = [search, ...world.searches];
    return ok({ ...f.KbFunnelRun, id: search.id, area_id: search.area_id, query: search.query });
  }
  m = /^\/kb\/explore\/runs\/([^/]+)\/(pause|continue)$/.exec(path);
  if (method === 'POST' && m) {
    const search = world.searches.find((s) => s.id === m![1]);
    if (!search) return { ok: false, status: 404, detail: 'No such search.' };
    search.state = m[2] === 'pause' ? 'paused' : 'running';
    search.stop_reason = m[2] === 'pause' ? 'user_pause' : null;
    return ok({ ...f.KbFunnelRun, id: search.id });
  }
  return { ok: false, status: 0, detail: `method/path not allowed: ${method} ${path}` };
}

/** The fake bridge, the app's services over it, and the real Explore clients — for one test. */
export function exploreHarness(world: ExploreWorld = exploreWorld()) {
  const request = vi.fn(async (req: BridgeRequest) => serveExplore(world, req));
  const bridge = { request } as unknown as Parameters<typeof createServices>[0];
  const services = createServices(bridge, null, { capture: null });
  return { world, request, bridge, services, clients: createExploreClients(services.client) };
}

/** The same without the app's services: the clients alone, for the pieces that take `ExploreClient`s. */
export function exploreClients(world: ExploreWorld = exploreWorld()) {
  const request = vi.fn(async (req: BridgeRequest) => serveExplore(world, req));
  return { world, request, clients: createExploreClients(new KbClient({ request } as never)) };
}

/** The requests the fake bridge saw for `METHOD /path` (a string, or a pattern for ids and queries). */
export function sent(request: { mock: { calls: Array<[BridgeRequest]> } }, method: string, path: string | RegExp): BridgeRequest[] {
  return request.mock.calls.map(([req]) => req).filter((req) => req.method === method && (typeof path === 'string' ? req.path === path : path.test(req.path)));
}
