// Harness for the U2 browser smoke: the real new interface on the browser fake backend.
// Served by Vite from frontend/ (scripts/kb-u2.smoke.spec.ts); never part of the app build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from '../KbApp';
import { createServices } from '../state/context';
import { PREFS_KEY } from '../state/prefs';
import { createBrowserFake } from './browserFake';
import { b2State, finishAnswer } from './fakeB2';
import '../styles/index.css';

const params = new URLSearchParams(location.search);
const b2 = b2State();
if (params.get('hold') === '1') b2.hold = true;
const fake = createBrowserFake(b2);
const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: params.get('onboarding') !== '1', ...prefs }));
const services = createServices(fake.bridge as never, localStorage);

// Handles for the smoke: finish a held answer, read what was sent.
Object.assign(window, { __kbFake: { b2, finish: (id: string) => finishAnswer(b2, id), services } });

document.documentElement.dataset.kbUi = '';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KbApp services={services} />
  </StrictMode>,
);
