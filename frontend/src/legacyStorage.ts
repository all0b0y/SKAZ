/** One-time compatibility for renderer preferences in a migrated Electron profile. */
export function migrateLegacyStorage(storage: Storage): void {
  const prefix = 'audiohelper.';
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(prefix)) continue;
    const target = `skaz.${key.slice(prefix.length)}`;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(target) === null) storage.setItem(target, value);
    storage.removeItem(key);
  }
}

try { migrateLegacyStorage(localStorage); } catch {
  // A full/unavailable renderer store must not prevent opening the app.
}
