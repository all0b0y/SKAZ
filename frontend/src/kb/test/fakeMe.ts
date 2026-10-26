// N6 «Я» (Me) in the shared fake backend: built-ins, skills, versions, agent edits and their Undo, in the
// shapes of the route contract (`.dev/docs/backlog-2026-10-26/N6-ME-API.md`), typed by the generated
// contract (types.gen.ts) like every other fake route.
// A fake on the external seam: it proves the UI's handling of contract-shaped answers, not the
// backend's encryption, limits or prompt rules (B3's tests own those).

import type { KbEndpoints, KbMemoryPart, KbMeSkill, KbMeSkillDetail, KbMeVersion } from '../../api/kb/types.gen';
import { FakeHttpError, type FakeWorld } from './fakeKb';

type KbMeSource = KbMeVersion['source'];
/** The «Я» routes of the generated contract. */
type KbMeRoute = Extract<keyof KbEndpoints, `${string} /kb/me` | `${string} /kb/me/${string}`>;

interface FakeMeVersion extends KbMeVersion { text: string }

export interface FakeMeSkill extends Omit<KbMeSkill, 'chars' | 'version' | 'updated_at'> {
  /** Newest last; the text of a skill is its last version's (none = never written). */
  versions: FakeMeVersion[];
}

export interface FakeMe {
  enabled: boolean;
  skills: FakeMeSkill[];
  /** An agent's edit in a chat → the skill and the version before it (for Undo). */
  edits: Record<string, { skill_id: string; before: number; undone: boolean }>;
}

const fail = (status: number, detail: string): never => { throw new FakeHttpError(status, detail); };
const BUILTIN_ORDER = ['profile', 'how-to-work', 'search'];

const builtin = (id: string, kind: KbMeSkill['kind'], title: string, description: string, limit: number | null): FakeMeSkill => ({
  id, kind, builtin: true, title, description, enabled: true, always_on: limit !== null, limit, versions: [],
});

/** «Я» as the backend starts: the three built-ins (titles/descriptions of `me.BUILTINS`), empty, on. */
export function freshMe(): FakeMe {
  return {
    enabled: true,
    skills: [
      builtin('profile', 'profile', 'Profile', 'Personal facts the user told you: name, studies or work, goals and deadlines.', 1400),
      builtin('how-to-work', 'how_to_work', 'How to work with me', 'How the user wants you to explain, answer, quiz and work with SKAZ.', 2200),
      builtin('search', 'search', 'Search', 'Where and how the user likes to look for sources: services, sites, kinds of sources.', null),
    ],
    edits: {},
  };
}

const meOf = (w: FakeWorld): FakeMe => (w.me ??= freshMe());
const textOf = (s: FakeMeSkill) => s.versions.at(-1)?.text ?? '';

function summary(s: FakeMeSkill): KbMeSkill {
  const last = s.versions.at(-1);
  const { versions: _v, ...rest } = s;
  void _v;
  return { ...rest, chars: textOf(s).length, version: last?.version ?? 0, updated_at: last?.created_at ?? null };
}
const detail = (s: FakeMeSkill): KbMeSkillDetail => ({ ...summary(s), text: textOf(s) });

function find(w: FakeWorld, id: string): FakeMeSkill {
  return meOf(w).skills.find((s) => s.id === id) ?? fail(404, 'This skill no longer exists.');
}

function ordered(me: FakeMe): KbMeSkill[] {
  const rank = (s: FakeMeSkill) => (s.builtin ? BUILTIN_ORDER.indexOf(s.id) : BUILTIN_ORDER.length);
  return [...me.skills].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).map(summary);
}

/** A new version of a skill's text (limits as the backend's: refused, never cut). */
export function writeMe(w: FakeWorld, id: string, text: string, source: KbMeSource, line: string, chatId: string | null = null): FakeMeSkill {
  const s = find(w, id);
  if (s.limit !== null && text.length > s.limit) {
    fail(422, `${s.title} is limited to ${s.limit.toLocaleString('en-US')} characters. Shorten it first.`);
  }
  const at = w.now ?? new Date().toISOString();
  s.versions.push({ version: (s.versions.at(-1)?.version ?? 0) + 1, created_at: at, source, chat_id: chatId, summary: line, chars: text.length, text });
  return s;
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';

type MeSpec<R extends KbMeRoute> = KbEndpoints[R];
type MeEntry<R extends KbMeRoute> = readonly [MeSpec<R>['status'], (world: FakeWorld, call: {
  path: MeSpec<R>['path']; query: Partial<MeSpec<R>['query']>; body: MeSpec<R>['body'];
}) => MeSpec<R>['response']];
export type FakeMeRoutes = { [R in KbMeRoute]: MeEntry<R> };

/** The «Я» routes; `undone` marks the chat part of an undone edit (and tells the chat's feed). */
export function meRoutes(undone: (w: FakeWorld, editId: string) => void): FakeMeRoutes {
  return {
    'GET /kb/me': [200, (w) => ({ enabled: meOf(w).enabled, skills: ordered(meOf(w)) })],
    'PUT /kb/me': [200, (w, { body }) => {
      meOf(w).enabled = body.enabled;
      return { enabled: meOf(w).enabled, skills: ordered(meOf(w)) };
    }],
    'GET /kb/me/skills/{skill_id}': [200, (w, { path }) => detail(find(w, path.skill_id))],
    'PUT /kb/me/skills/{skill_id}': [200, (w, { path, body }) => {
      const s = find(w, path.skill_id);
      // `null` = unchanged, as the backend's KbMeUpdate.
      const { title, description, text, enabled } = body;
      // Only a rename of a built-in is a conflict (backend MeStore.update; N6-ME-API.md 409).
      if (s.builtin && title != null && title !== s.title) fail(409, 'Built-in skills keep their name.');
      if (title != null && !title.trim()) fail(422, 'A skill needs a name.');
      if (text != null && text !== textOf(s)) writeMe(w, s.id, text, 'user', 'Edited by you');
      if (title != null) s.title = title.trim();
      if (description != null) s.description = description.trim();
      if (enabled != null) s.enabled = enabled;
      return detail(s);
    }],
    'POST /kb/me/skills': [201, (w, { body }) => {
      if (!body.title.trim()) fail(422, 'A skill needs a name.');
      const me = meOf(w);
      let id = slug(body.title);
      for (let n = 2; me.skills.some((s) => s.id === id); n += 1) id = `${slug(body.title).slice(0, 45)}-${n}`;
      me.skills.push({
        id, kind: 'skill', builtin: false, title: body.title.trim(), description: body.description.trim(), enabled: true,
        always_on: false, limit: null, versions: [],
      });
      return detail(writeMe(w, id, body.text, 'user', 'Created by you'));
    }],
    'DELETE /kb/me/skills/{skill_id}': [204, (w, { path }) => {
      const s = find(w, path.skill_id);
      if (s.builtin) fail(409, 'Built-in skills can’t be deleted; clear their text instead.');
      meOf(w).skills = meOf(w).skills.filter((x) => x !== s);
    }],
    'GET /kb/me/skills/{skill_id}/versions': [200, (w, { path }) => ({
      versions: [...find(w, path.skill_id).versions].reverse().map(({ text: _t, ...v }) => { void _t; return v; }),
    })],
    'POST /kb/me/skills/{skill_id}/versions/{version}/restore': [200, (w, { path }) => {
      const s = find(w, path.skill_id);
      const version = Number(path.version);
      const old = s.versions.find((v) => v.version === version) ?? fail(404, 'This version no longer exists.');
      return detail(writeMe(w, s.id, old.text, 'restore', `Restored version ${version}`));
    }],
    'POST /kb/me/edits/{edit_id}/undo': [200, (w, { path }) => {
      const edit = meOf(w).edits[path.edit_id] ?? fail(404, 'This change no longer exists.');
      if (edit.undone) fail(409, 'This change was already undone.');
      const s = find(w, edit.skill_id);
      const before = s.versions.find((v) => v.version === edit.before)?.text ?? '';
      writeMe(w, s.id, before, 'restore', 'Undid the agent’s change');
      edit.undone = true;
      undone(w, path.edit_id);
      return detail(s);
    }],
  };
}

/** An agent's edit of «Я» in a chat (what `me_edit` leaves): the new version and the chat part. */
export function agentEdit(w: FakeWorld, edit: {
  edit_id: string; skill_id: string; text: string; summary: string; action?: KbMemoryPart['action']; chat_id?: string;
}): KbMemoryPart {
  const s = find(w, edit.skill_id);
  const before = s.versions.at(-1)?.version ?? 0;
  writeMe(w, s.id, edit.text, 'agent', edit.summary, edit.chat_id ?? null);
  meOf(w).edits[edit.edit_id] = { skill_id: s.id, before, undone: false };
  return {
    type: 'memory', edit_id: edit.edit_id, skill_id: s.id, skill_title: s.title, action: edit.action ?? 'append',
    summary: edit.summary, undone: false,
  };
}
