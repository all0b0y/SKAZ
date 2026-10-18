// Harness for the U2 browser smoke: the real new interface on the browser fake backend.
// Served by Vite from frontend/ (scripts/kb-u2.smoke.spec.ts); never part of the app build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from '../KbApp';
import { createServices } from '../state/context';
import { PREFS_KEY } from '../state/prefs';
import { createBrowserFake } from './browserFake';
import { finishAnswer, syncSpeechConsent } from './fakeKb';
import { chatWorld, studyWorld } from './fixtures';
import '../styles/index.css';

const params = new URLSearchParams(location.search);
// `world=study`: chats with a deck and a test, and a saved deck page (0.3.1 S, scripts/kb-s.smoke.spec.ts).
const world = params.get('world') === 'study' ? studyWorld() : chatWorld();
if (params.get('hold') === '1') world.hold = true;
// Soniox chosen without the consent to send audio (review B2 #6).
if (params.get('soniox') === 'off') {
  world.speech.cloud_consent = false;
  syncSpeechConsent(world);
}
const fake = createBrowserFake(world);
const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: params.get('onboarding') !== '1', ...prefs }));
const services = createServices(fake.bridge as never, localStorage);

// Handles for the smoke: finish a held answer, read what was sent.
Object.assign(window, { __kbFake: { world, finish: (id: string) => finishAnswer(world, id), services } });

document.documentElement.dataset.kbUi = '';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KbApp services={services} />
  </StrictMode>,
);
