import { render } from '@testing-library/react';
import { KbApp } from '../KbApp';
import { createServices } from '../state/context';
import { PREFS_KEY, type Prefs } from '../state/prefs';
import { createFakeBridge, type FakeKbState } from './fakeBridge';

/** Render the whole new interface on a fake bridge, with stored prefs seeded first. */
export function renderKb(options: { state?: FakeKbState; prefs?: Partial<Prefs> } = {}) {
  localStorage.clear();
  localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, ...options.prefs }));
  const fake = createFakeBridge(options.state);
  const services = createServices(fake.bridge, localStorage);
  const view = render(<KbApp services={services} />);
  return { ...view, fake, services };
}

export const storedPrefs = (): Partial<Prefs> => JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
