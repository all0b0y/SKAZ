/**
 * Things that happen once per app session (one services object = one running app; tests get a fresh
 * one per render). Kept outside React state so a list that unmounts on a section switch and mounts
 * again remembers that its entrance already played (stage 5 rule: switching never replays it).
 */
const SLOTS = new WeakMap<object, Map<string, unknown>>();

/** The value kept under `id` for this session; `fresh` = it was created by this call. */
export function sessionSlot<T>(owner: object, id: string, init: () => T): { value: T; fresh: boolean } {
  let slots = SLOTS.get(owner);
  if (!slots) { slots = new Map(); SLOTS.set(owner, slots); }
  if (slots.has(id)) return { value: slots.get(id) as T, fresh: false };
  const value = init();
  slots.set(id, value);
  return { value, fresh: true };
}
