import type { IconName } from '../ui';
import type { SettingsSection } from '../state/ui';
import { WIKI_TERMS_KEYWORDS } from './wikiTerms';

export interface SectionDef {
  id: SettingsSection;
  label: string;
  icon: IconName;
}

/** Menu groups (decisions 30/31/34, v17 + v21). */
export const NAV: ReadonlyArray<{ group: string; items: ReadonlyArray<SectionDef> }> = [
  { group: 'Connections', items: [{ id: 'conn', label: 'Accounts & keys', icon: 'link' }] },
  {
    group: 'Work',
    items: [
      { id: 'models', label: 'Models', icon: 'models' },
      { id: 'rec', label: 'Recording & speech', icon: 'mic' },
      { id: 'wiki', label: 'Wiki', icon: 'wiki' },
      { id: 'skills', label: 'Skills', icon: 'skills' },
    ],
  },
  {
    group: 'App',
    items: [
      { id: 'storage', label: 'Storage', icon: 'storage' },
      { id: 'privacy', label: 'Privacy', icon: 'privacy' },
      { id: 'look', label: 'Appearance', icon: 'appearance' },
      { id: 'about', label: 'About', icon: 'about' },
    ],
  },
];

export const SECTION_LABEL: Record<SettingsSection, string> = Object.fromEntries(
  NAV.flatMap((g) => g.items.map((i) => [i.id, i.label])),
) as Record<SettingsSection, string>;

export interface RowDef {
  id: string;
  section: SettingsSection;
  group: string;
  label: string;
  hint?: string;
  /** Extra words the search matches (synonyms). */
  keywords?: string;
}

/**
 * Every settings row, in display order. The search reads this table; each section renders its
 * rows from it, so a row cannot be findable but missing (or the reverse).
 */
export const ROWS: ReadonlyArray<RowDef> = [
  // Accounts & keys
  { id: 'agent-codex', section: 'conn', group: 'Agent', label: 'Codex', hint: 'ChatGPT subscription', keywords: 'openai chatgpt login sign in' },
  { id: 'agent-claude', section: 'conn', group: 'Agent', label: 'Claude Code', hint: 'Claude subscription or Anthropic key', keywords: 'anthropic login sign in' },
  { id: 'agent-hermes', section: 'conn', group: 'Agent', label: 'Hermes Agent', hint: 'Subscriptions and API keys, added through Hermes', keywords: 'nous provider providers subscription api key sign in openrouter anthropic gemini deepseek fallback order' },
  { id: 'agent-opencode', section: 'conn', group: 'Agent', label: 'OpenCode', hint: 'Model providers you sign in to through OpenCode', keywords: 'opencode provider providers subscription api key sign in anthropic openai copilot zen' },
  { id: 'key-openrouter', section: 'conn', group: 'API keys', label: 'OpenRouter', hint: 'Other models with an API key', keywords: 'key token jev' },
  { id: 'key-soniox', section: 'conn', group: 'API keys', label: 'Soniox', hint: 'Live recording and translation', keywords: 'key speech asr' },
  { id: 'local-whisper', section: 'conn', group: 'On this computer', label: 'Whisper on this computer', hint: 'Works without internet', keywords: 'local offline speech asr download' },
  { id: 'local-decisions', section: 'conn', group: 'On this computer', label: 'Decision model on this computer', hint: 'Where to file, whether to merge pages — without sending data', keywords: 'local download llama' },
  // Models
  // Models screen v2 (2026-10-20): grouped by purpose — Chats / Wiki / Recordings.
  { id: 'default-agent', section: 'models', group: 'Chats', label: 'Default agent', hint: 'For new chats; any chat can change it', keywords: 'codex claude hermes engine' },
  { id: 'chat-model', section: 'models', group: 'Chats', label: 'Chat model', hint: 'Change it in the message field; each agent keeps its last choice', keywords: 'model effort reasoning last remembered' },
  { id: 'picker-models', section: 'models', group: 'Chats', label: 'Models in the picker', hint: 'Which agents, providers and models the message field lists; favourites on top', keywords: 'edit models visible hidden show hide favorites favourites star providers' },
  { id: 'wiki-model', section: 'models', group: 'Wiki', label: 'Wiki model', hint: 'Notes, concepts, connections · new jobs only', keywords: 'model effort reasoning summary pages notes' },
  { id: 'wiki-budget', section: 'models', group: 'Wiki', label: 'Wiki budget per material', hint: 'Characters to and from the model for one material, its connections included. When reached, it pauses with Continue', keywords: 'budget limit characters spend cost usage pause continue' },
  { id: 'decisions', section: 'models', group: 'Wiki', label: 'Wiki decisions', hint: 'Where to file a material, whether to merge or link pages', keywords: 'openrouter jev local system one' },
  { id: 'recognition-check', section: 'models', group: 'Recordings', label: 'Recognition check', hint: 'Finds recognition errors in recordings', keywords: 'model effort corrections agent off' },
  // Recording & speech
  { id: 'mic', section: 'rec', group: 'Sound', label: 'Microphone', hint: 'Default for new recordings', keywords: 'input device level permission' },
  { id: 'system-audio', section: 'rec', group: 'Sound', label: 'Computer audio', hint: 'Record together with the microphone (Zoom, video)', keywords: 'system sound permission' },
  { id: 'asr-service', section: 'rec', group: 'Recognition', label: 'Service', hint: 'Soniox or on this computer', keywords: 'speech recognition asr whisper soniox' },
  { id: 'soniox-consent', section: 'rec', group: 'Recognition', label: 'Send audio to Soniox', hint: 'Needed for Soniox; you can take it back at any time', keywords: 'privacy consent cloud soniox audio permission' },
  { id: 'speech-model', section: 'rec', group: 'Recognition', label: 'Speech model on this computer', hint: 'Whisper files for recognition without internet', keywords: 'local whisper offline delete remove disk space download' },
  { id: 'speech-languages', section: 'rec', group: 'Recognition', label: 'Speech languages', hint: 'A hint for recognition', keywords: 'language languages' },
  { id: 'translate-default', section: 'rec', group: 'Recognition', label: 'Default translation', keywords: 'translate language' },
  // Wiki
  { id: 'wiki-language', section: 'wiki', group: 'Content', label: 'Wiki language', hint: 'Original terms stay in brackets', keywords: 'language' },
  { id: 'auto-files', section: 'wiki', group: 'Content', label: 'New files and links → wiki', keywords: 'automatic add' },
  { id: 'auto-text', section: 'wiki', group: 'Content', label: 'Pasted text → wiki', keywords: 'automatic add' },
  { id: 'auto-fix', section: 'wiki', group: 'Upkeep', label: 'Fix recognition automatically', hint: 'Doubtful places are only highlighted', keywords: 'corrections' },
  { id: 'bg-links', section: 'wiki', group: 'Upkeep', label: 'Find connections in the background', hint: 'When the app is idle, with your permission', keywords: 'links graph' },
  { id: 'links-now', section: 'wiki', group: 'Upkeep', label: 'Find connections now', keywords: 'links graph run' },
  { id: 'study-new', section: 'wiki', group: 'Study', label: 'New cards per day', hint: 'For each folder; the rest wait for another day', keywords: 'flashcards cards deck review fsrs limit learn' },
  // The wiki legend (wiki-terms v1 A): the search finds this row by any term's name or meaning.
  { id: 'wiki-terms', section: 'wiki', group: 'Help', label: 'Wiki terms', hint: 'What each label on a wiki page means', keywords: WIKI_TERMS_KEYWORDS },
  // Skills (0.3.1 H3): SKAZ's own skills folder only
  { id: 'humanizer', section: 'skills', group: 'Writing', label: 'Humanizer', hint: 'Writes like a person: no filler, no AI tells. Used only in ordinary chat replies, not wiki processing, cards or tests. Quotes from sources are never changed. v3.1.0 · MIT · github.com/blader/humanizer', keywords: 'skills writing ai style tells filler human natural' },
  { id: 'skill-codex', section: 'skills', group: 'Applies to', label: 'Codex', keywords: 'humanizer skills loaded status' },
  { id: 'skill-claude', section: 'skills', group: 'Applies to', label: 'Claude Code', keywords: 'humanizer skills loaded status' },
  { id: 'skill-hermes', section: 'skills', group: 'Applies to', label: 'Hermes Agent', keywords: 'humanizer skills loaded status' },
  { id: 'skill-opencode', section: 'skills', group: 'Applies to', label: 'OpenCode', keywords: 'humanizer skills loaded status' },
  // Storage
  { id: 'lib-folder', section: 'storage', group: 'Library', label: 'Folder', hint: 'Materials and wiki are plain .md files', keywords: 'library path location documents' },
  { id: 'obsidian', section: 'storage', group: 'Library', label: 'Open in Obsidian', hint: 'The library folder opens as an Obsidian vault; SKAZ adds it to Obsidian’s vaults the first time.', keywords: 'vault obsidian markdown' },
  { id: 'export', section: 'storage', group: 'Library', label: 'Export', hint: 'The whole wiki and materials as plain .md, sources as footnotes', keywords: 'markdown backup copy folder footnotes' },
  // Privacy
  { id: 'p-soniox', section: 'privacy', group: 'Where data goes', label: 'Soniox', keywords: 'privacy data cloud' },
  { id: 'p-agent', section: 'privacy', group: 'Where data goes', label: 'Your agent', hint: 'Codex, Claude Code or Hermes Agent', keywords: 'privacy data cloud' },
  { id: 'p-openrouter', section: 'privacy', group: 'Where data goes', label: 'OpenRouter', keywords: 'privacy data cloud' },
  { id: 'p-local', section: 'privacy', group: 'Where data goes', label: 'On this computer', keywords: 'privacy local' },
  { id: 'log', section: 'privacy', group: '', label: 'Activity log', hint: 'Without conversation text or keys', keywords: 'logs' },
  // Appearance
  { id: 'theme', section: 'look', group: '', label: 'Theme', keywords: 'dark light mode colour color appearance' },
  { id: 'text-size', section: 'look', group: '', label: 'Text size', keywords: 'font scale zoom' },
  { id: 'ui-language', section: 'look', group: '', label: 'Interface language', hint: 'Answer and wiki language are set separately', keywords: 'english' },
  // About
  { id: 'version', section: 'about', group: '', label: 'Version', keywords: 'about' },
  { id: 'updates', section: 'about', group: '', label: 'Updates', hint: 'From GitHub releases, checked at start and once a day', keywords: 'update check new version install download release' },
  { id: 'github', section: 'about', group: '', label: 'GitHub', keywords: 'source code repository' },
];

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Rows whose label, hint, group, section or keywords contain every word of the query. */
export function searchRows(query: string): RowDef[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return ROWS.filter((row) => {
    const hay = fold([row.label, row.hint ?? '', row.group, SECTION_LABEL[row.section], row.keywords ?? ''].join(' '));
    return words.every((w) => hay.includes(w));
  });
}
