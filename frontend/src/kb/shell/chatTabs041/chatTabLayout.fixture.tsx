import { createRoot } from 'react-dom/client';
import { KbApp } from '../../KbApp';
import { createServices } from '../../state/context';
import { PREFS_KEY } from '../../state/prefs';
import { createBrowserFake } from '../../test/browserFake';
import { chatMessage } from '../../test/fakeKb';
import { chatWorld } from '../../test/fixtures';
import '../../styles/index.css';

const world = chatWorld();
const seed = world.chats[0]!;
world.chats = Array.from({ length: 14 }, (_, i) => ({
  ...seed, id: 'tab-' + i, title: 'Conversation ' + i, cursor: 1, state: 'answering',
  messages: [chatMessage('reply-' + i, 1, 'assistant', seed.created_at, [], { state: 'streaming' })],
}));
localStorage.setItem(PREFS_KEY, JSON.stringify({ onboardingDone: true, motion: 'off' }));
const { bridge } = createBrowserFake(world);
const services = createServices(bridge, localStorage, { capture: null });
for (const chat of world.chats) services.chats.getState().open(chat.id);
createRoot(document.getElementById('root')!).render(<KbApp services={services} />);

export function deliverUpdate() {
  const chat = world.chats.at(-1)!;
  world.chatEvents[chat.id] = [{ type: 'delta', message_id: chat.messages[0]!.id, seq: ++chat.cursor, text: 'Measured delta' }];
  const other = world.chats[1]!;
  world.listChanges.push({ seq: ++world.listCursor, chat: { ...other, state: 'idle', unread: true } });
}
