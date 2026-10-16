import { render } from '@testing-library/react';
import { KbApp } from '../KbApp';
import { createServices, type KbBridge } from '../state/context';
import { PREFS_KEY, type Prefs } from '../state/prefs';
import type { CaptureFactory } from '../recording/capture';
import { createFakeBridge } from './fakeBridge';
import type { FakeWorld } from './fakeKb';

/** Render the whole new interface on a fake bridge over one world, with stored prefs seeded first. */
export function renderKb(options: { world?: FakeWorld; prefs?: Partial<Prefs>; capture?: CaptureFactory | null; bridge?: Partial<KbBridge> } = {}) {
  localStorage.clear();
  localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, ...options.prefs }));
  const fake = createFakeBridge(options.world);
  // Host methods a test adds (macOS privacy state, system audio support, …) on the same bridge object.
  if (options.bridge) Object.assign(fake.bridge, options.bridge);
  const services = createServices(fake.bridge, localStorage, { capture: options.capture ?? null });
  const view = render(<KbApp services={services} />);
  return { ...view, fake, services };
}

export const storedPrefs = (): Partial<Prefs> => JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
