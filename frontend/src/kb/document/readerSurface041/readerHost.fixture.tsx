import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { KbApp } from '../../KbApp';
import { createServices } from '../../state/context';
import { PREFS_KEY } from '../../state/prefs';
import { createBrowserFake } from '../../test/browserFake';
import { chatWorld, docWorld } from '../../test/fixtures';

const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, theme, rightWidth: 320, motion: 'calm' }));
const fake = createBrowserFake({ ...docWorld(), chats: chatWorld().chats });
const services = createServices(fake.bridge, localStorage, { capture: null });

createRoot(document.getElementById('root')!).render(<KbApp services={services} />);
