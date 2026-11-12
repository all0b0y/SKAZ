import { vi } from 'vitest';
import type { KbArea, KbAreaMap, KbFunnelCandidate, KbFunnelRun, KbSearchPlan, KbSearchPlanRequest } from '../../../api/kb/types.gen';
import { createFakeKb } from '../../api/fake';
import { contractFixtures as f } from '../../api/fake/fixtures';

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
