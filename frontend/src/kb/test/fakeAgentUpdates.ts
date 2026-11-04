// U1 agent updates in the shared fake backend: the record SKAZ's own checks keep, and the buttons.
// A fake on the external seam for component tests only — it proves the UI's handling of answers,
// not the backend's checks (backend/tests/knowledge/test_agent_updates*.py do that).
import type { KbAgentUpdate, KbAgentUpdates } from '../../api/kb/types.gen';
import type { FakeRoutes, FakeWorld } from './fakeKb';

const NAMES = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes Agent', opencode: 'OpenCode' } as const;

export function agentUpdate(engine: KbAgentUpdate['engine'], patch: Partial<KbAgentUpdate> = {}): KbAgentUpdate {
  return {
    engine, name: NAMES[engine], channel: 'unknown', installed: null, latest: null, available: false, unseen: false,
    skipped: null, busy: false, phase: 'idle', action: null, task_id: null,
    note: `Updates ${NAMES[engine]} for this whole Mac, including Terminal.`,
    services_note: engine === 'hermes' ? 'Running Hermes services keep the old version until you restart them.' : null,
    failure: null, checked_at: null, waiting: [], ...patch,
  };
}

/** Nothing found yet (the default world): no offer, no dot. */
export function emptyAgentUpdates(): KbAgentUpdates {
  return { auto: true, checking: false, checked_at: null, next_check_at: null, unseen: false,
    agents: (['codex', 'claude_code', 'hermes', 'opencode'] as const).map((e) => agentUpdate(e)) };
}

const updatesOf = (w: FakeWorld): KbAgentUpdates => (w.agentUpdates ??= emptyAgentUpdates());
const settle = (u: KbAgentUpdates): KbAgentUpdates => {
  u.unseen = u.agents.some((a) => a.unseen);
  return structuredClone(u);
};
/** The routes, given the fake's own HTTP failure (a function, so this module needs no value of fakeKb). */
export function agentUpdateRoutes(fail: (status: number, detail: string) => never): FakeRoutes {
  const find = (w: FakeWorld, engine: string) => updatesOf(w).agents.find((a) => a.engine === engine) ?? fail(404, 'Unknown agent.');
  return {
    'GET /kb/agents/updates': [200, (w) => settle(updatesOf(w))],
    'PUT /kb/agents/updates/settings': [200, (w, { body }) => { const u = updatesOf(w); u.auto = body.auto; return settle(u); }],
    'POST /kb/agents/updates/check-now': [200, (w) => { const u = updatesOf(w); u.checked_at = new Date().toISOString(); return settle(u); }],
    'POST /kb/agents/updates/seen': [200, (w) => {
      const u = updatesOf(w);
      u.agents.forEach((a) => { a.unseen = false; });
      return settle(u);
    }],
    'POST /kb/agents/{engine}/update': [202, (w, { path }) => {
      const a = find(w, path.engine);
      if (!a.available) fail(409, `There is no newer ${a.name} to install.`);
      a.phase = a.busy ? 'queued' : 'updating';
      a.action = 'upgrade';
      return settle(updatesOf(w));
    }],
    'POST /kb/agents/{engine}/update/cancel': [200, (w, { path }) => {
      const a = find(w, path.engine);
      Object.assign(a, { phase: 'idle', action: null, task_id: null });
      return settle(updatesOf(w));
    }],
    'POST /kb/agents/{engine}/update/skip': [200, (w, { path, body }) => {
      const a = find(w, path.engine);
      Object.assign(a, { skipped: body.version, available: false, unseen: false });
      return settle(updatesOf(w));
    }],
    'POST /kb/agents/{engine}/update/rollback': [202, (w, { path }) => {
      const a = find(w, path.engine);
      if (a.failure?.rollback !== 'skaz') fail(409, `SKAZ can't roll ${a.name} back. Roll it back by hand.`);
      Object.assign(a, { phase: 'updating', action: 'rollback' });
      return settle(updatesOf(w));
    }],
  };
}
