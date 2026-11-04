import type { ReactNode } from 'react';
import type { KbServices } from '../state/context';
import { ChatList } from '../chat/ChatList';
import { AssistantMessage, UserMessage, type AnswerActions } from '../chat/Message';
import type { QuestionActions } from '../chat/QuestionActions';
import { PermissionCard } from '../chat/permission';
import { QuestionBlock } from '../chat/QuestionBlock';
import { Composer } from '../composer/Composer';
import { PageView } from '../wiki/PageView';
import { AllMaterials } from '../materials/AllMaterials';
import { LibraryPanel } from '../library/LibraryPanel';
import { NotificationsFeed } from '../notifications/Feed';
import { SettingsModal } from '../settings/SettingsModal';
import type { SettingsSection } from '../state/ui';
import { Toast, type ToastData } from '../ui/Toast';
import {
  ANSWER_CHAT, COMPOSER_TEXT, composerAttachments, exchangeMessages, permissionStates, questionStates, type BoardWorldId,
} from '../test/boardWorlds';

/**
 * Layer 3 of the design board: product patterns — the real components of the app on fixture data
 * (test/boardWorlds.ts), each cell with its own stores over the browser fake. A state is reached the
 * way the app reaches it (a store action, a ⌘-click on a row, a draft in the composer's own shape);
 * what can't be reached without a real backend is listed in `gaps`, never drawn with copied markup.
 */

export interface PatternCell {
  label: string;
  /** Default: the pattern's world. */
  world?: BoardWorldId;
  /** Width of the cell's stage (px); default: the pattern's `cellWidth`. */
  width?: number;
  /** Height of the stage, for components that fill their pane (lists, panels, the table). */
  height?: number;
  /** The pane the component lives in inside the app: the side panel, or a centre/document pane. */
  pane?: 'side' | 'pane';
  /** Real selection header for a standalone side-list pattern. */
  header?: string;
  /**
   * A side pane with the centre sheet beside it, across the gutter, as in the window: for lists
   * whose open row bridges into the sheet (the chat list), so the bridge and its corners show.
   */
  sheet?: boolean;
  /** Store steps after the warm-up, before the component is shown. */
  prepare?: (s: KbServices) => void | Promise<void>;
  /** DOM steps after the cell is on screen, done as a user would (a ⌘-click selects a row). */
  act?: (root: HTMLElement, s: KbServices) => void | Promise<void>;
  render: () => ReactNode;
}

export interface BoardPattern {
  id: string;
  title: string;
  note: string;
  world: BoardWorldId;
  /** Width of the frame: the iframe on the canvas and the screenshot. */
  width: number;
  cellWidth?: number;
  /** The components are fixed to the window (a modal): the frame has this height instead of growing. */
  fixedHeight?: number;
  cells: PatternCell[];
  /** What the pattern can't show on the browser fake, said on the board and in the report. */
  gaps?: string[];
}

const noop = () => undefined;

const ANSWER_ACTIONS: AnswerActions = { onRegenerate: noop, onResume: noop, onSave: noop, busy: null };
const QUESTION_ACTIONS: QuestionActions = { waitReason: null, onEdit: async () => null, onResend: noop };

let exchange: ReturnType<typeof exchangeMessages> | null = null;
const messages = () => (exchange ??= exchangeMessages());

/** ⌘-click on a chat row of the side list: the list's own selection (useListSelection) picks it. */
function cmdClick(root: HTMLElement, id: string): void {
  const row = root.querySelector<HTMLElement>(`[data-sel-id="${id}"] button`);
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
}

const openSettingsAt = (section: SettingsSection) => (s: KbServices) => { s.ui.getState().openSettings(section); };

const settingsPattern = (id: string, section: SettingsSection, title: string, note: string, gaps: string[] = []): BoardPattern => ({
  id, title, note, world: 'chat', width: 1040, fixedHeight: 760,
  cells: [{ label: '', prepare: openSettingsAt(section), render: () => <SettingsModal /> }],
  gaps: ['a settings row on its own — rows exist only inside the Settings window (its Row is not exported), so the pattern is the real window at a section.', ...gaps],
});

const toasts: Array<{ toast: ToastData }> = [
  { toast: { id: 1, text: 'Moved 2 chats to Physics', tone: 'done', action: { label: 'Undo', run: noop } } },
  { toast: { id: 2, text: 'Already pinned' } },
  { toast: { id: 3, text: 'Couldn’t save the note: the library folder is unavailable.', tone: 'problem' } },
];

export const PATTERNS: readonly BoardPattern[] = [
  {
    id: 'chat-rows',
    title: 'Chat list rows',
    note: 'The side list beside the centre sheet: the open chat (its row bridges into the sheet, no mark on it), pinned, answering (the Connecting nodes mark), new answer (dot), «Waiting for you» (a permission or a question), then two rows ⌘-selected with the selection bar.',
    world: 'agentControls', width: 880, cellWidth: 300,
    cells: [
      { label: 'Open · pinned · answering · unread · waiting', pane: 'side', header: 'Chats', sheet: true, height: 560, prepare: (s) => { s.chats.getState().open(ANSWER_CHAT); }, render: () => <ChatList /> },
      {
        label: 'Selected (⌘-click on two rows)', pane: 'side', header: 'Chats', sheet: true, height: 560,
        prepare: (s) => { s.chats.getState().open(ANSWER_CHAT); },
        act: (root) => { cmdClick(root, 'c3'); cmdClick(root, 'c6'); },
        render: () => <ChatList />,
      },
    ],
  },
  {
    id: 'chat-exchange',
    title: 'Chat exchange',
    note: 'Your question; an answer with citation marks, a page chip, a connection block and the sources row; the agent thinking; an answer cut by a limit with Resume; a stopped answer; Regenerate that failed.',
    world: 'chat', width: 820, cellWidth: 760,
    cells: [
      { label: 'Question', render: () => <UserMessage message={messages().question} actions={QUESTION_ACTIONS} /> },
      { label: 'Answer · citations · sources row', render: () => <AssistantMessage chatId={ANSWER_CHAT} message={messages().answer} actions={ANSWER_ACTIONS} /> },
      { label: 'Thinking (no text yet)', render: () => <AssistantMessage chatId={ANSWER_CHAT} message={messages().thinking} actions={ANSWER_ACTIONS} /> },
      { label: 'Interrupted · Resume', render: () => <AssistantMessage chatId={ANSWER_CHAT} message={messages().interrupted} actions={ANSWER_ACTIONS} /> },
      { label: 'Stopped', render: () => <AssistantMessage chatId={ANSWER_CHAT} message={messages().stopped} actions={ANSWER_ACTIONS} /> },
      {
        label: 'Regenerate failed (the reason by the buttons)',
        render: () => <AssistantMessage chatId={ANSWER_CHAT} message={messages().answer} actions={{ ...ANSWER_ACTIONS, error: 'Claude Code can’t answer now: Not signed in.' }} />,
      },
    ],
    gaps: ['a streamed answer growing word by word — the board shows still states only.'],
  },
  {
    id: 'composer',
    title: 'Composer',
    note: 'The message field of a new chat: empty; with typed text (handed over through the composer bus); with attachments ready / saving / failed (the composer’s own draft).',
    world: 'chat', width: 820, cellWidth: 760,
    cells: [
      { label: 'Empty', pane: 'pane', render: () => <Composer chatId={null} placeholder="Ask about your materials · @ to reference" /> },
      {
        label: 'With text', pane: 'pane',
        prepare: (s) => { s.composer.getState().push([{ kind: 'text', text: COMPOSER_TEXT }], { focus: false }); },
        render: () => <Composer chatId={null} placeholder="Ask about your materials · @ to reference" />,
      },
      {
        label: 'With attachments', pane: 'pane',
        prepare: (s) => { s.composer.getState().drafts.set('new', { nodes: [document.createTextNode('Compare these with the lecture')], attachments: composerAttachments() }); },
        render: () => <Composer chatId={null} placeholder="Ask about your materials · @ to reference" />,
      },
    ],
  },
  {
    id: 'wiki-page',
    title: 'Wiki page',
    note: 'A concept page as the document panel shows it: header, folders, blocks of every kind (from sources with citations, connection, explanation edited by you, your note).',
    world: 'doc', width: 700, cellWidth: 640,
    cells: [{ label: 'Entropy', pane: 'pane', height: 1000, render: () => <PageView target={{ type: 'page', id: 'p-entropy' }} nonce={1} /> }],
  },
  {
    id: 'material-rows',
    title: 'Material rows',
    note: 'All materials (processing «Writing notes», ready, in the wiki, failed) and the Materials side panel.',
    world: 'doc', width: 1440, cellWidth: 1060,
    cells: [
      { label: 'All materials', pane: 'pane', height: 560, render: () => <AllMaterials hidden={false} /> },
      { label: 'Materials side panel', pane: 'side', header: 'Materials', width: 280, height: 560, render: () => <LibraryPanel /> },
    ],
  },
  {
    id: 'notification-rows',
    title: 'Notification rows',
    note: 'The feed: decisions that wait for you (sources disagree, doubtful corrections, a link that failed, an excluded instruction) and plain notices.',
    world: 'chat', width: 420, cellWidth: 360,
    cells: [{ label: 'Feed', pane: 'side', height: 960, render: () => <NotificationsFeed /> }],
  },
  settingsPattern('settings-wiki', 'wiki', 'Settings rows · Wiki', 'Select, switches, a button row, the per-day stepper.'),
  settingsPattern('settings-rec', 'rec', 'Settings rows · Recording & speech', 'Device select, segmented service, consent switch, language chips, a download row.',
    ['the microphone list and computer audio — they need the Electron host (a browser says «Not supported» / «Not available on this Mac»).']),
  settingsPattern('settings-conn', 'conn', 'Settings rows · Accounts & keys', 'Agent cards (ready, not installed), API key rows, local models.'),
  {
    id: 'toast',
    title: 'Toast',
    note: 'The real toast (it lives at the bottom of the window; here it is laid out in the page). Top to bottom: done with Undo · a neutral note · a problem.',
    world: 'chat', width: 700, cellWidth: 640,
    cells: toasts.map(({ toast }) => ({ label: '', render: () => <Toast toast={toast} onClose={noop} /> })),
    gaps: ['the toast inside a cell — it is a portal to <body>, so board.css lays the three out in the page, one under another.'],
  },
  {
    id: 'permission',
    title: 'Permission card',
    note: 'An agent’s request to change the wiki: waiting (edit, delete) with the decision bar, then the folded outcomes.',
    world: 'agentControls', width: 820, cellWidth: 760,
    cells: permissionStates().map(({ label, chatId, part }) => ({
      label, render: () => <PermissionCard chatId={chatId} part={part} onOpen={noop} onReview={noop} />,
    })),
  },
  {
    id: 'question',
    title: 'Question block',
    note: 'An agent’s question: waiting (recommended row first, 1–4, Other answer…), then answered / superseded / cancelled.',
    world: 'agentControls', width: 820, cellWidth: 760,
    cells: questionStates().map(({ label, chatId, part }) => ({ label, render: () => <QuestionBlock chatId={chatId} part={part} /> })),
  },
];

export const patternById = (id: string): BoardPattern | undefined => PATTERNS.find((p) => p.id === id);
