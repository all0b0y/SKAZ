import type { KbMessagePart } from '../../api/kb/types.gen';
import type { KbServices } from '../state/context';
import { citationRef } from '../state/document';
import type { Prefs } from '../state/prefs';
import { ANSWER_CHAT, type BoardWorldId } from '../test/boardWorlds';
import type { FakeWorld } from '../test/fakeKb';

/**
 * Layer 4 of the design board: whole screens — the real KbApp on the browser fake, put into a state
 * the way the app gets there (store actions the UI itself calls), at every width of SCREEN_SIZES.
 */
export interface BoardScreen {
  id: string;
  title: string;
  world: BoardWorldId;
  /** Prefs the window starts with, on top of the frame's look (section, onboarding…). */
  prefs?: Partial<Prefs>;
  /** After the app is up: open what the screen shows. */
  prepare?: (s: KbServices, world: FakeWorld) => void | Promise<void>;
}

/** The first citation of the answered chat — what a click on its citation mark opens. */
function firstCitation(world: FakeWorld) {
  const answer = world.chats.find((c) => c.id === ANSWER_CHAT)?.messages.find((m) => m.role === 'assistant');
  const part = answer?.parts.find((p): p is Extract<KbMessagePart, { type: 'cite' }> => p.type === 'cite');
  if (!part) throw new Error('The answered chat has no citation');
  return part.citation;
}

const openChat = (id: string) => (s: KbServices) => { s.chats.getState().open(id); };

export const SCREENS: readonly BoardScreen[] = [
  { id: 'chat', title: 'Chat with an answer', world: 'chat', prefs: { section: 'chats' }, prepare: openChat(ANSWER_CHAT) },
  {
    id: 'chat-source', title: 'Chat + material opened from a citation', world: 'chat', prefs: { section: 'chats' },
    prepare: (s, world) => {
      s.chats.getState().open(ANSWER_CHAT);
      s.ui.getState().openDocument(citationRef(firstCitation(world)));
    },
  },
  {
    id: 'wiki-page', title: 'Wiki page beside the Wiki panel', world: 'doc', prefs: { section: 'wiki' },
    prepare: (s) => { s.ui.getState().openDocument({ type: 'page', id: 'p-entropy' }); },
  },
  { id: 'materials', title: 'All materials', world: 'doc', prefs: { section: 'materials' }, prepare: (s) => { s.ui.getState().showCenter('materials'); } },
  { id: 'settings-look', title: 'Settings → Appearance', world: 'chat', prefs: { section: 'chats' }, prepare: (s) => { s.chats.getState().open(ANSWER_CHAT); s.ui.getState().openSettings('look'); } },
  { id: 'notifications', title: 'Notifications', world: 'chat', prefs: { section: 'notifications' }, prepare: openChat(ANSWER_CHAT) },
  {
    id: 'decision', title: 'A decision opened from a notification', world: 'chat', prefs: { section: 'notifications' },
    prepare: (s) => { s.chats.getState().open(ANSWER_CHAT); s.ui.getState().openDecision('n1'); },
  },
  { id: 'agent-waits', title: 'The agent waits for you (permission)', world: 'agentControls', prefs: { section: 'chats' }, prepare: openChat('c8') },
  { id: 'onboarding', title: 'Onboarding, first step', world: 'firstLaunch', prefs: { onboardingDone: false } },
];

export const screenById = (id: string): BoardScreen | undefined => SCREENS.find((s) => s.id === id);
