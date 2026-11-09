// Synthetic UI states for F1–F5: every state of the approved n4-v3 and of the v4 gallery. All titles,
// authors and numbers are invented. These are examples, not model or API results.
import type {
  KbArea, KbAreaMap, KbAreaMaterial, KbAreaMaterials, KbExploring, KbFinding, KbFindings, KbFreshnessMark,
  KbFreshnessMarks, KbFunnelRun, KbJobs, KbLinkCheck, KbMaterialRepeats, KbRepeatCheck, KbResearchPermission,
  KbResearchTask, KbRunBudget, KbWeeklyCheck, KbWeeklySettings,
} from '../../../api/kb/types.gen';
import { contractFixtures as f } from './fixtures';

export interface ExploreScene {
  map?: KbAreaMap;
  materials?: KbAreaMaterials;
  run?: KbFunnelRun;
  jobs?: KbJobs;
  findings?: KbFindings;
  finding?: KbFinding;
  exploring?: KbExploring;
  task?: KbResearchTask;
  permission?: KbResearchPermission;
  repeats?: KbMaterialRepeats;
  repeatCheck?: KbRepeatCheck;
  freshness?: KbFreshnessMarks;
  linkCheck?: KbLinkCheck;
  weekly?: KbWeeklyCheck;
  weeklySettings?: KbWeeklySettings;
}

// ---- the map (n4-v3 numbers) -----------------------------------------------------------------------
type AreaOptions = Partial<KbArea>;
function tile(id: string, parent_id: string | null, level: KbArea['level'], name: string, pages: number,
  sources: number, newest_source_year: number | null, options: AreaOptions = {}): KbArea {
  return {
    ...f.KbArea, id, parent_id, level, name, original_name: name, pages, sources, newest_source_year,
    taxonomy_id: `fixture-${id}`, has_children: level !== 'topic', pinned: false, new_findings: 0,
    marked_materials: 0, children_covered: 0, children_total: 0, wiki_share: pages / 412,
    depth: pages === 0 ? 'empty' : pages < 10 ? 'thin' : pages < 40 ? 'medium' : 'dense', gap_reason: null,
    topic_ids: [], recent_activity_at: null, ...options,
  };
}
const recent = '2026-11-08T18:00:00Z';
const physical = tile('domain-physical', null, 'domain', 'Physical Sciences', 239, 74, 2026,
  { children_covered: 4, children_total: 9, marked_materials: 19, new_findings: 7, recent_activity_at: recent });
const social = tile('domain-social', null, 'domain', 'Social Sciences', 128, 39, 2025,
  { children_covered: 4, children_total: 8, marked_materials: 9, new_findings: 2, recent_activity_at: recent });
const life = tile('domain-life', null, 'domain', 'Life Sciences', 29, 11, 2024,
  { children_covered: 1, children_total: 5, marked_materials: 2 });
const health = tile('domain-health', null, 'domain', 'Health Sciences', 16, 7, 2023,
  { children_covered: 1, children_total: 5, marked_materials: 1 });
const cs = tile('field-cs', physical.id, 'field', 'Computer Science', 169, 52, 2026,
  { children_covered: 5, children_total: 11, marked_materials: 14, new_findings: 6, recent_activity_at: recent });
const ai = tile('area-ai', cs.id, 'subfield', 'Artificial Intelligence', 62, 21, 2026,
  { children_covered: 5, children_total: 14, marked_materials: 7, new_findings: 4, recent_activity_at: recent });
const csChildren = [
  ai,
  tile('sub-is', cs.id, 'subfield', 'Information Systems', 38, 12, 2025, { children_covered: 3, children_total: 9, marked_materials: 3 }),
  tile('sub-net', cs.id, 'subfield', 'Computer Networks and Communications', 31, 9, 2025,
    { children_covered: 3, children_total: 10, marked_materials: 2, new_findings: 2, recent_activity_at: recent }),
  tile('sub-hci', cs.id, 'subfield', 'Human-Computer Interaction', 22, 6, 2024, { children_covered: 2, children_total: 8, marked_materials: 2 }),
  tile('sub-sw', cs.id, 'subfield', 'Software', 16, 4, 2023, { children_covered: 2, children_total: 9 }),
];
const rag = tile('topic-rag', ai.id, 'topic', 'Retrieval-augmented generation', 21, 7, 2026,
  { marked_materials: 3, new_findings: 2, recent_activity_at: recent, pinned: true, topic_ids: ['T-fixture-rag'] });
const thinFact = tile('topic-fact', ai.id, 'topic', 'Factuality and hallucination', 4, 1, 2023,
  { new_findings: 1, gap_reason: 'thin · 1 source, 2023' });
const gapVerify = tile('topic-verify', ai.id, 'topic', 'Self-correction and verification', 0, 0, null,
  { gap_reason: 'Next to LLM agents · no pages yet' });
const gapEval = tile('topic-eval', ai.id, 'topic', 'Evaluating LLM answers', 0, 0, null,
  { gap_reason: 'Next to RAG · no pages yet' });
const aiChildren = [
  rag,
  tile('topic-agents', ai.id, 'topic', 'LLM agents and tool use', 17, 6, 2026, { marked_materials: 2, new_findings: 1, recent_activity_at: recent }),
  tile('topic-kg', ai.id, 'topic', 'Knowledge graphs', 12, 4, 2025, { marked_materials: 1 }),
  tile('topic-asr', ai.id, 'topic', 'Speech recognition', 8, 3, 2024, { marked_materials: 1 }),
  thinFact, gapVerify, gapEval,
];
const closing = [gapVerify, gapEval, thinFact];
const homeMap: KbAreaMap = { parent_id: null, breadcrumbs: [], areas: [physical, social, life, health],
  total_pages: 412, total_sources: 131, worth_closing: closing };
const csMap: KbAreaMap = { ...homeMap, parent_id: cs.id, breadcrumbs: [physical, cs], areas: csChildren };
const aiMap: KbAreaMap = { ...homeMap, parent_id: ai.id, breadcrumbs: [physical, cs, ai], areas: aiChildren };

// ---- materials -------------------------------------------------------------------------------------
const baseMaterial: KbAreaMaterial = f.KbAreaMaterials.materials[0] as KbAreaMaterial;
const areaMaterial = (material_id: string, title: string, kind: KbAreaMaterial['kind'],
  options: Partial<KbAreaMaterial> = {}): KbAreaMaterial => ({
  ...baseMaterial, material_id, title, kind, read_mark: null, freshness_mark_ids: [],
  repeat_status: 'not_checked', repeated_percent: null, repeats_source_titles: [], ...options,
});
const ragMaterials: KbAreaMaterials = {
  materials: [
    areaMaterial('material-beyond', 'RAG beyond the basics', 'web', { repeat_status: 'checked',
      repeated_percent: 80, repeats_source_titles: ['Lecture 7'], read_mark: 'useful_method' }),
    areaMaterial('material-lecture', 'Lecture 7 · RAG in practice', 'recording', { repeat_status: 'checked',
      repeated_percent: 0 }),
    areaMaterial('material-guide', 'A guide to retrieval evaluation', 'pdf', { freshness_mark_ids: ['mark-version'] }),
    areaMaterial('material-collection', 'Building a useful document collection', 'book'),
  ],
  not_checked_count: 2,
  next_cursor: null,
};

// ---- jobs ------------------------------------------------------------------------------------------
const baseRun: KbFunnelRun = f.KbFunnelRun;
const candidateBudget = (used: number, batch = 1): KbRunBudget => ({ unit: 'candidate', limit: 30, used,
  remaining: 30 - used, total_used: used + (batch - 1) * 30, batch, free_only: false });
const searching: KbFunnelRun = { ...baseRun, id: 'run-search', task_id: null, area_id: cs.id, query: '',
  state: 'running', stage: 'decision', budget: candidateBudget(0), checkpoint: null, decision_provider: 'local',
  counters: { checked: 240, after_rules: 198, decided: 120, on_topic: 0, novelty_checked: 0, new: 0, covered: 0 },
  active_area_ids: ['area-ai', 'sub-net'] };
const done: KbFunnelRun = { ...searching, state: 'done', stage: 'ready', stop_reason: 'completed', active_area_ids: [],
  budget: candidateBudget(30),
  counters: { checked: 240, after_rules: 198, decided: 198, on_topic: 38, novelty_checked: 30, new: 9, covered: 12 } };
const baseJob = f.KbResearchTask.run;
const taskRun = (overrides: Partial<KbResearchTask['run']>): KbResearchTask['run'] => ({
  ...baseJob, owner: 'research', state: 'running', stage: 'novelty', budget: candidateBudget(18), stop_reason: null,
  counters: { checked: 240, after_rules: 198, decided: 198, on_topic: 38, novelty_checked: 18, new: 6, covered: 4 },
  ...overrides,
});
const task = (run: KbResearchTask['run']): KbResearchTask => ({ ...f.KbResearchTask, id: 'task-rag',
  title: 'Evidence for reliable RAG', description: 'Find recent work on evaluating RAG answers. Look for evidence that adds to Lecture 7.',
  chat_id: 'chat-research-rag', finding_count: run.counters.new, run });

// ---- findings --------------------------------------------------------------------------------------
const baseFinding: KbFinding = f.KbFinding;
const pageRef = (page_id: string, title: string) => ({ page_id, title, block_id: null });
const selfCheck = pageRef('page-self-check', 'Self-check loops');
function find(id: string, title: string, label: KbFinding['label'], channel: KbFinding['channel'], authors: string[],
  year: number, reason: string, options: Partial<KbFinding> = {}): KbFinding {
  const publication = { ...baseFinding.work.publication, year, date: `${year}-10-15` };
  return { ...baseFinding, id, label, channel, reason, task_id: 'task-rag', area_id: rag.id, area_path: ['AI', 'RAG'],
    text_available: 'full_text', theses: [{ text: reason, label, wiki_refs: [] }],
    work: { ...baseFinding.work, id: `work-${id}`, title, authors, publication }, ...options };
}
const contradicts = find('finding-contradicts', 'Self-correction in LLMs does not improve factuality without external feedback',
  'contradicts', 'continues', ['Huang', 'Chen'], 2026, 'Self-review alone does not fix wrong answers — your page Self-check loops says it does.',
  { area_path: ['AI', 'LLM agents'], wiki_refs: [selfCheck], cites_materials: [{ material_id: 'material-reflexion', title: 'Reflexion' }],
    repeat_hint: 'Sections 1–2 repeat your wiki — Brief tour will skip them', theses: [{ label: 'contradicts', wiki_refs: [selfCheck],
      text: 'Self-review without outside signals rarely improves accuracy.' }] });
const isNew = find('finding-new', 'Claim-level grounding for long-lived agent memory', 'new', 'search', ['Okafor', 'Lind'], 2026,
  'A way to re-check each wiki claim against its source on every update — nothing like it in your wiki.');
const extendsWiki = find('finding-extends', 'FSRS-6: spaced repetition fitted to 1.2 billion reviews', 'extends', 'continues', ['Ye', 'Su'], 2025,
  'New forgetting-curve parameters; extends Spaced repetition (your source is from 2023).', { task_id: 'task-wiki',
    area_path: ['Psychology', 'Memory and learning'], wiki_refs: [pageRef('page-spaced', 'Spaced repetition')],
    cites_materials: [{ material_id: 'material-fsrs', title: 'FSRS-4.5' }], text_available: 'abstract_only' });
const branch = find('finding-branch', 'Provenance tracking in clinical knowledge bases', 'branch', 'branches', ['Martins'], 2026,
  'Same roots as your RAG pages, applied in medicine: audit trails for every answer.', { task_id: 'task-wiki',
    area_path: ['Health Sciences', 'Medicine'], wiki_refs: [pageRef('page-rag', 'RAG')], shared_source_count: 3 });
const staleness = find('finding-staleness', 'Measuring knowledge-base staleness with claim decay', 'new', 'search', ['Rossi'], 2025,
  'A score for how fast claims in a topic go out of date — useful for your outdated-sources check.', { task_id: 'task-wiki',
    area_path: ['Information Systems', 'Data quality'] });
const covered = find('finding-covered', 'Retrieval-augmented generation: a practical overview', 'covered', 'search', ['Berg'], 2025,
  'All confirmed theses already occur in your wiki.', { theses: [{ text: 'RAG combines a model with retrieved material.',
    label: 'covered', wiki_refs: [pageRef('page-rag', 'RAG')] }] });
const paid = find('finding-paid', 'Tracing claims through changing sources', 'new', 'search', ['Morgan'], 2026,
  'This abstract describes a way to track claims when source versions change. Your wiki covers citations, but not version-aware tracing.',
  { task_id: 'task-wiki', text_available: 'abstract_only' });
paid.work = { ...paid.work, publication_type: 'article', locations: [{ url: 'https://example.org/publisher',
  kind: 'publisher', open_access: false }], access: { paid: true, alternatives_checked: true, free_alternative_ids: [],
  suggestion_shown_at: '2026-11-09T10:00:00Z', publisher_url: 'https://example.org/publisher',
  recommendation: "This article is paid. I think it's useful because it tracks claims across source versions, which your wiki doesn't cover. You can check it yourself; if you get it, add it to your materials." } };
const abstractOnly = find('finding-abstract', 'Evaluating evidence across long answers', 'extends', 'continues', ['Chen'], 2026,
  'The abstract proposes evaluating the support for each claim across a whole answer, beyond the short-answer examples in Lecture 7.',
  { text_available: 'abstract_only' });
const grouped: KbFindings = {
  groups: [
    { task_id: 'task-rag', task_title: 'Evidence for reliable RAG', task_state: 'running', updated_at: '2026-11-09T10:00:00Z',
      findings: [contradicts, isNew, abstractOnly] },
    { task_id: 'task-wiki', task_title: 'Something new for my wiki', task_state: 'done', updated_at: '2026-11-08T10:00:00Z',
      findings: [extendsWiki, branch, staleness, paid] },
  ],
  covered_count: 12, next_cursor: null, checked_at: '2026-11-09T10:00:00Z', full_text_key_hint_count: 1,
};

// ---- permission card -------------------------------------------------------------------------------
const permission = (overrides: Partial<KbResearchPermission>): KbResearchPermission => ({ ...f.KbResearchPermission,
  arguments: { description: 'Find recent evidence for reliable RAG' }, ...overrides });

// ---- repeats ---------------------------------------------------------------------------------------
const repeatJob: KbRepeatCheck = { ...f.KbRepeatCheck, area_id: rag.id, materials_checked: 2, materials_remaining: 5,
  budget: { unit: 'claim_comparison', limit: 30, used: 18, remaining: 12, total_used: 18, batch: 1, free_only: false } };

// ---- N1 marks --------------------------------------------------------------------------------------
const baseMark: KbFreshnessMark = f.KbFreshnessMarks.marks[0] as KbFreshnessMark;
const marks = (mark: Partial<KbFreshnessMark>, last_link_check: KbFreshnessMarks['last_link_check'] = null): KbFreshnessMarks => ({
  marks: [{ ...baseMark, ...mark }], last_link_check });
const versionMark = marks({ id: 'mark-version', kind: 'new_version', reason: 'v3 is out (2026)', version: 'v3', current_version: 'v2',
  evidence_label: 'arXiv version history', actions: ['replace_version'],
  affected_statements: [{ page_id: 'page-eval', title: 'RAG evaluation', block_id: 'block-1', sole_source: true, also_supported_by: [] }] });
const retractedMark = marks({ id: 'mark-retracted', kind: 'retracted', reason: 'Retracted (2026)', version: null, current_version: null,
  evidence_label: 'Crossref', replacement_work_id: null, actions: ['delete_source', 'keep_marked'],
  affected_statements: [
    { page_id: 'page-self-check', title: 'Self-check loops', block_id: 'block-1', sole_source: true, also_supported_by: [] },
    { page_id: 'page-self-check', title: 'Self-check loops', block_id: 'block-2', sole_source: false,
      also_supported_by: [{ material_id: 'material-lecture', title: 'Lecture 7' }] },
  ] });
const baseObservation = f.KbLinkCheck.observations[0] as KbLinkCheck['observations'][number];
const confirmedGone = { ...baseObservation, outcome: 'confirmed_gone', reason: 'http_404', status_code: 404 } as const;
const couldNotCheck = { ...baseObservation, outcome: 'could_not_check', reason: 'timeout', status_code: null,
  first_gone_at: null, confirm_after: null } as const;

// ---- weekly ----------------------------------------------------------------------------------------
const weekly: KbWeeklyCheck = { ...f.KbWeeklyCheck, state: 'done', stage: 'ready', stop_reason: 'completed',
  candidates_waiting: 14, new_versions: 2, retractions: 1, newer_contradictions: 0 };

export const scenes = {
  // Approved n4-v3
  home: { map: homeMap, findings: grouped },
  area: { map: csMap, findings: grouped },
  topic: { map: aiMap, materials: ragMaterials, findings: grouped },
  searching: { map: csMap, run: searching, jobs: { jobs: [{ ...f.KbJobs.jobs[0]!, id: searching.id, owner: 'explore',
    title: 'Computer Science', stage: 'decision', task_id: null, chat_id: null, area_id: cs.id, budget: searching.budget }] } },
  done: { map: csMap, run: done, findings: grouped },
  find: { map: csMap, finding: contradicts },
  explore: { map: csMap, finding: contradicts, exploring: f.KbExploring },
  // Findings
  paid: { finding: paid },
  abstract_only: { finding: abstractOnly },
  covered: { finding: covered },
  contradicts: { finding: contradicts },
  extends: { finding: extendsWiki },
  branch: { finding: branch },
  // Research task
  research_running: { task: task(taskRun({})) },
  research_paused: { task: task(taskRun({ state: 'paused', stop_reason: 'user_pause' })) },
  research_budget: { task: task(taskRun({ state: 'paused', stop_reason: 'budget', budget: candidateBudget(30),
    counters: { checked: 240, after_rules: 198, decided: 198, on_topic: 38, novelty_checked: 30, new: 9, covered: 12 } })) },
  research_done: { task: task(taskRun({ state: 'done', stage: 'ready', stop_reason: 'completed', budget: candidateBudget(30) })) },
  permission_pending: { permission: permission({}) },
  permission_allowed: { permission: permission({ status: 'allowed', task_id: 'task-rag', task_title: 'Evidence for reliable RAG', task_state: 'running' }) },
  permission_denied: { permission: permission({ status: 'denied' }) },
  // Honest stops
  no_decision_model: { run: { ...searching, state: 'paused', stop_reason: 'decision_model_required', decision_provider: null,
    decision_choices: ['download_local', 'openrouter_jev'] } },
  daily_limit: { run: { ...searching, state: 'paused', stage: 'collect', stop_reason: 'openalex_daily_limit', retry_at: '2026-11-10T00:00:00Z' } },
  // N3
  repeats_marked: { repeats: f.KbMaterialRepeats },
  not_checked: { repeats: { ...f.KbMaterialRepeats, status: 'not_checked', percent: null, repeated: 0, total: 0,
    from_materials: [], paragraphs: [], checked_at: null } },
  older_materials: { materials: ragMaterials },
  older_running: { materials: ragMaterials, repeatCheck: repeatJob },
  older_paused: { materials: ragMaterials, repeatCheck: { ...repeatJob, state: 'paused', stop_reason: 'user_pause' } },
  // N1
  new_version: { freshness: versionMark },
  retracted: { freshness: retractedMark },
  link_gone: { freshness: marks({ id: 'mark-gone', kind: 'link_gone', reason: 'Original link is gone · your copy is kept', version: null,
    current_version: null, replacement_work_id: null, evidence_label: null, actions: ['keep_marked'], affected_statements: [] }, confirmedGone) },
  couldnt_check: { freshness: { marks: [], last_link_check: couldNotCheck }, linkCheck: { ...f.KbLinkCheck, state: 'done', stage: 'ready',
    stop_reason: 'completed', observations: [couldNotCheck] } },
  newer_contradicts: { freshness: marks({ id: 'mark-newer', kind: 'newer_contradicts', reason: 'A newer source disagrees (2026)', version: null,
    current_version: null, actions: ['keep_marked'] }) },
  footnote: { freshness: { ...versionMark, last_link_check: null } },
  // Weekly check
  weekly_done: { weekly, weeklySettings: { ...f.KbWeeklySettings, latest_check_id: weekly.id, candidates_waiting: 14 } },
  weekly_running: { weekly: { ...weekly, state: 'running', stage: 'collect', stop_reason: null, candidates_waiting: 0,
    candidate_ids: [], new_versions: 0, retractions: 0 } },
} satisfies Record<string, ExploreScene>;
export type SceneName = keyof typeof scenes;
