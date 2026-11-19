import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { KbApp } from '../../KbApp';
import { createServices } from '../../state/context';
import { PREFS_KEY } from '../../state/prefs';
import { createBrowserFake } from '../../test/browserFake';
import { chatWorld, docWorld } from '../../test/fixtures';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, theme, rightWidth: 320, motion: 'calm' }));
const docs = docWorld();
const chats = chatWorld();
docs.materials.push(chats.materials.find((material) => material.id === 'm5')!);
docs.wikiFiles = {
  index: {
    text: '# Index\n\n[[Concepts/entropy|Open entropy from the index]]',
    links: [{ target: 'Concepts/entropy', page: { id: 'p-entropy', title: 'Entropy', kind: 'concept' }, material_id: null }],
  },
};
if (params.has('withoutNotesCitations')) {
  const notes = docs.pages.find((page) => page.id === 'p-note8')!;
  for (const block of notes.blocks) block.citations = [];
}
const fake = createBrowserFake({ ...docs, chats: chats.chats });
const services = createServices(fake.bridge, localStorage, { capture: null });

createRoot(document.getElementById('root')!).render(<KbApp services={services} />);
