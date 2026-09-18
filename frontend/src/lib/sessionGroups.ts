import type { Session } from '../api/types';
import { parseTags } from './sessionTags';

// Local navigation preferences only: no transcript, credentials or model context.
// This is deliberately separate from backend project_id / cross-session AI scope.
const KEY = 'audiohelper.session-groups.v1';
export interface SessionGroup { id: string; name: string; tag: string }
export interface SessionGroups { version: 1; groups: SessionGroup[]; membership: Record<string, string | null> }
export const emptyGroups = (): SessionGroups => ({ version: 1, groups: [], membership: {} });

export function loadGroups(): SessionGroups {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyGroups();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Saved groups could not be read.');
  const data = value as Partial<SessionGroups>;
  if (data.version !== 1 || !Array.isArray(data.groups) || !data.membership || typeof data.membership !== 'object'
    || Array.isArray(data.membership)
    || data.groups.some((g) => !g || typeof g.id !== 'string' || typeof g.name !== 'string' || typeof g.tag !== 'string')
    || new Set(data.groups.map((g) => g.id)).size !== data.groups.length
    || Object.values(data.membership).some((id) => id !== null && (typeof id !== 'string' || !data.groups!.some((g) => g.id === id)))) {
    throw new Error('Saved groups could not be read.');
  }
  return data as SessionGroups;
}

export function saveGroups(value: SessionGroups): void {
  // Write before updating the UI: quota/privacy errors must not look like success.
  localStorage.setItem(KEY, JSON.stringify(value));
}

export function importLegacyGroups(value: SessionGroups, sessions: readonly Session[]): SessionGroups {
  const unseen = sessions.filter((s) => !Object.hasOwn(value.membership, s.id));
  if (!unseen.length) return value;
  const groups = [...value.groups];
  const membership = { ...value.membership };
  for (const session of unseen) {
    // Old UI allowed many title tags. First tag wins; original title is untouched.
    const tag = parseTags(session.title)[0];
    let group = tag ? groups.find((g) => g.tag.toLowerCase() === tag.toLowerCase()) : undefined;
    if (tag && !group) {
      let name = tag;
      while (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) name += ' (imported)';
      group = { id: crypto.randomUUID(), name, tag };
      groups.push(group);
    }
    Object.defineProperty(membership, session.id, { value: group?.id ?? null, enumerable: true, configurable: true, writable: true });
  }
  return { ...value, groups, membership };
}

export function updateGroup(value: SessionGroups, id: string | null, nameInput: string, tagInput: string): SessionGroups {
  const name = nameInput.trim();
  const tag = tagInput.trim().replace(/^#/, '');
  if (!name || name.length > 60) throw new Error('Use a group name between 1 and 60 characters.');
  if (name.toLowerCase() === 'all' || value.groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('A group with this name already exists.');
  }
  if (tag && (tag.length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(tag))) throw new Error('Use one tag, up to 32 letters, numbers, underscores or hyphens.');
  const group: SessionGroup = { id: id ?? crypto.randomUUID(), name, tag };
  return { ...value, groups: id ? value.groups.map((g) => g.id === id ? group : g) : [...value.groups, group] };
}

export function moveSession(value: SessionGroups, sessionId: string, groupId: string | null): SessionGroups {
  if (groupId !== null && !value.groups.some((g) => g.id === groupId)) throw new Error('This group no longer exists.');
  return { ...value, membership: { ...value.membership, [sessionId]: groupId } };
}

export function deleteGroup(value: SessionGroups, id: string): SessionGroups {
  return { ...value, groups: value.groups.filter((g) => g.id !== id),
    membership: Object.fromEntries(Object.entries(value.membership).map(([session, group]) => [session, group === id ? null : group])) };
}

export function reorderGroups(value: SessionGroups, ids: string[]): SessionGroups {
  if (ids.length !== value.groups.length || new Set(ids).size !== ids.length || ids.some((id) => !value.groups.some((g) => g.id === id))) return value;
  return { ...value, groups: ids.map((id) => value.groups.find((g) => g.id === id)!) };
}
