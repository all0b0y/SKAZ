// Harness for the U2 browser smoke: the real new interface on the browser fake backend.
// Served by Vite from frontend/ (scripts/kb-u2.smoke.spec.ts); never part of the app build.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { KbApp } from '../KbApp';
import { createServices } from '../state/context';
import { PREFS_KEY } from '../state/prefs';
import { createBrowserFake } from './browserFake';
import { finishAnswer, syncSpeechConsent } from './fakeKb';
import { accountsWorld, agent, chatWorld, providersOf, studyWorld } from './fixtures';
import { stretchNames } from './longNames';
import '../styles/index.css';

const params = new URLSearchParams(location.search);
// `world=study`: chats with a deck and a test, and a saved deck page (0.3.1 S, scripts/kb-s.smoke.spec.ts).
const world = params.get('world') === 'study' ? studyWorld() : chatWorld();
if (params.get('hold') === '1') world.hold = true;
// `accounts=v3`: Settings → Accounts & keys as in the confirmed v3 mock-up (scripts/kb-accounts.smoke.spec.ts).
if (params.get('accounts') === 'v3') accountsWorld(world);
// Soniox chosen without the consent to send audio (review B2 #6).
if (params.get('soniox') === 'off') {
  world.speech.cloud_consent = false;
  syncSpeechConsent(world);
}
// `long=1`: long RU/EN agent, provider, model and deck names, and a long save error (U1 layout smoke).
if (params.get('long') === '1') stretchNames(world, { agent, providersOf });
const fake = createBrowserFake(world);
if (params.get('long') === '1') {
  const request = fake.bridge.request;
  fake.bridge.request = (async (req: Parameters<typeof request>[0]) => (/\/kb\/study\/[^/]+\/save$/.test(req.path)
    ? { ok: false, status: 409, detail: 'Не удалось сохранить: в библиотеке уже есть страница с очень длинным названием, выберите другое имя и попробуйте снова. The page could not be written.' }
    : request(req))) as typeof request;
}
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
