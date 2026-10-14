export type InterfaceChoice = 'kb' | 'legacy';

/** Which interface to start. Anything but an explicit 'kb' keeps the current one. */
export function chooseInterface(envValue: string | undefined, readStored: () => string | null): InterfaceChoice {
  if (envValue === 'kb') return 'kb';
  try {
    return readStored() === 'kb' ? 'kb' : 'legacy';
  } catch {
    return 'legacy';
  }
}
