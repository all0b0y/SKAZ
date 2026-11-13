import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KbFinding, KbFunnelRun, KbScienceSettings } from '../../../api/kb/types.gen';
import { KbClient } from '../client';
import { createScienceClient } from '../science';
import { createExploreClient } from '../explore';
import { createAreasClient } from '../areas';
import { createFreshnessClient } from '../freshness';
import { createMaintenanceClient } from '../maintenance';
import { createRepeatsClient } from '../repeats';
import { createFakeScienceClient } from './science';
import { createFakeExploreClient } from './explore';
import { createFakeAreasClient } from './areas';
import { createFakeFreshnessClient } from './freshness';
import { createFakeMaintenanceClient } from './maintenance';
import { createFakeRepeatsClient } from './repeats';
import { contractFixtures } from './fixtures';
import { createFakeKb } from './index';
import { scenes } from './scenes';

describe('0.4.0 fake contract', () => {
  it('implements the same generated contract as each real client', () => {
    expectTypeOf(createFakeScienceClient()).toEqualTypeOf<ReturnType<typeof createScienceClient>>();
    expectTypeOf(createFakeExploreClient()).toEqualTypeOf<ReturnType<typeof createExploreClient>>();
    expectTypeOf(createFakeAreasClient()).toEqualTypeOf<ReturnType<typeof createAreasClient>>();
    expectTypeOf(createFakeFreshnessClient()).toEqualTypeOf<ReturnType<typeof createFreshnessClient>>();
    expectTypeOf(createFakeMaintenanceClient()).toEqualTypeOf<ReturnType<typeof createMaintenanceClient>>();
    expectTypeOf(createFakeRepeatsClient()).toEqualTypeOf<ReturnType<typeof createRepeatsClient>>();
    expectTypeOf(createFakeScienceClient().settings()).toEqualTypeOf<Promise<KbScienceSettings>>();
    expectTypeOf(createFakeExploreClient().run('run-1')).toEqualTypeOf<Promise<KbFunnelRun>>();
  });

  it('provides all approved scenes and the current access states', () => {
    expect(Object.keys(scenes)).toEqual(expect.arrayContaining([
      'home', 'area', 'topic', 'searching', 'done', 'find', 'explore', 'paid', 'abstract_only',
      'no_decision_model', 'daily_limit',
      'older_running', 'older_paused',
      'new_version', 'retracted', 'link_gone', 'couldnt_check', 'footnote', 'weekly_done', 'weekly_running',
    ]));
    expect(scenes.home.map.areas.map((area) => area.level)).toEqual(['domain', 'domain', 'domain', 'domain']);
    expect(scenes.topic.map.areas.some((area) => area.gap_reason !== null && area.pages === 0)).toBe(true);
    expect(new Set(scenes.done.findings.groups.flatMap((group) => group.findings.map((item) => item.label))))
      .toEqual(new Set(['new', 'extends', 'contradicts', 'branch']));
    expect(scenes.covered.finding.label).toBe('covered');
    expect(scenes.searching.run.counters).toMatchObject({ checked: 240, after_rules: 198, decided: 120 });
    const retractedClaims = scenes.retracted.freshness.marks[0]?.affected_statements ?? [];
    expect(retractedClaims.map((claim) => claim.sole_source)).toEqual([true, false]);
    expect(scenes.couldnt_check.freshness.marks).toEqual([]);
    expect(scenes.couldnt_check.freshness.last_link_check?.outcome).toBe('could_not_check');
    expect(scenes.paid.finding.work.access.alternatives_checked).toBe(true);
    expect(scenes.paid.finding.work.access.free_alternative_ids).toEqual([]);
    expect(scenes.paid.finding.text_available).toBe('abstract_only');
    expect(scenes.topic.map.areas[0]?.level).toBe('topic');
    expect(scenes.topic.materials.not_checked_count).toBe(2);
    expect(scenes.not_checked.repeats.percent).toBeNull();
  });

  it('keeps every budget in every scene consistent, as the backend model requires', () => {
    const budgets: Array<{ unit: string; limit: number; used: number; remaining: number; total_used: number }> = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value === null || typeof value !== 'object') return;
      if ('total_used' in value) budgets.push(value as (typeof budgets)[number]);
      Object.values(value).forEach(walk);
    };
    walk(scenes);
    expect(budgets.length).toBeGreaterThan(10);
    for (const budget of budgets) {
      expect(budget.used + budget.remaining).toBe(budget.limit);
      expect(budget.total_used).toBeGreaterThanOrEqual(budget.used);
      if (budget.unit === 'candidate') expect(budget.limit).toBe(30);
    }
  });

  it('shows the chosen scene through the fake API and isolates what it returns', async () => {
    const kb = createFakeKb('paid');
    expectTypeOf(kb.explore.finding).returns.resolves.toEqualTypeOf<KbFinding>();
    const finding = await kb.explore.finding('finding-paid');
    expect(finding.work.access.paid).toBe(true);
    finding.work.access.paid = false;
    expect((await kb.explore.finding('finding-paid')).work.access.paid).toBe(true);
    expect((await createFakeKb('home').areas.map()).areas).toHaveLength(4);
    expect((await createFakeKb().explore.run('run-1')).id).toBe('run-1');
  });

  it('returns isolated fixture objects without a bridge or network', async () => {
    const first = await createFakeScienceClient().settings();
    first.enabled = false;
    expect((await createFakeScienceClient().settings()).enabled).toBe(true);
    expect((await createFakeExploreClient().findings()).groups[0]?.task_id).toBe('task-1');
    expect((await createFakeAreasClient().signals()).signals[0]?.origin).toBe('user_action');
  });

  it('real client retains the exact generated route/body/query through KbClient', async () => {
    const requests: unknown[] = [];
    const client = new KbClient({ request: async <T,>(request: unknown) => {
      requests.push(request);
      return { ok: true as const, status: 200, data: contractFixtures.KbScienceSettings as T };
    } });
    await createScienceClient(client).update_settings({ enabled: true, consent: 'topics_dois_ids' });
    expect(requests[0]).toEqual({ method: 'PUT', path: '/kb/settings/science', query: undefined,
      body: { enabled: true, consent: 'topics_dois_ids' } });
  });
});
