// Types of the package-2 contract (.dev/wiki-build/API-B2.md) that types.gen.ts does not have yet.
// Same names and fields as the pydantic models the backend areas (C1, W2, S3) are writing in
// parallel; after the merge the orchestrator replaces these with the generated ones.
// `B2Endpoints` overrides/extends `KbEndpoints` in the typed client (kb/api/client.ts).

import type {
  KbAgentDefault, KbAgentInstallInfo, KbAgentLogin, KbAgentLoginResult, KbAgentModel, KbBlockHit, KbCitation,
  KbDecisionProviderUpdate, KbDecisions, KbFragmentHit, KbInstallLine, KbInstallStart, KbJob, KbMaterialGuard,
  KbPageHit, KbSnippetPart, KbWikiSettings as KbWikiSettingsB1, KbWikiSettingsUpdate as KbWikiSettingsUpdateB1,
} from '../../api/kb/types.gen';

export type EngineId = 'codex' | 'claude_code' | 'hermes';
export type MaterialKind = 'recording' | 'audio' | 'video' | 'video_link' | 'pdf' | 'book' | 'web' | 'text';
export type PageKind = 'concept' | 'note' | 'folder' | 'analysis';

// ---- §1.1 Notifications -------------------------------------------------------------------

export interface KbNotificationAction {
  id: string;
  label: string;
  primary: boolean;
  needs_text: boolean;
}

export interface KbSubjectRef {
  type: 'material' | 'page' | 'chat';
  id: string;
  block_id?: string | null;
  seg?: number | null;
}

export interface KbNotification {
  id: string;
  seq: number;
  kind: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  requires_action: boolean;
  actions: KbNotificationAction[];
  subject: KbSubjectRef | null;
  created_at: string;
  dismissed_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

export interface KbNotificationFeed {
  items: KbNotification[];
  cursor: number;
  unread: number;
  requires_action: number;
}

export interface KbResolve {
  action: string;
  text?: string | null;
}

export interface KbNotificationsRead {
  up_to_seq: number;
}

export interface KbDiscrepancySide {
  block_id: string;
  text: string;
  citation: KbCitation;
  material_title: string;
  folder_name: string;
}

export interface KbDiscrepancyPayload {
  page_id: string;
  page_title: string;
  sides: [KbDiscrepancySide, KbDiscrepancySide];
  explanation_block_id: string | null;
  /** Not in the contract: the explanation text itself (see report Q). Shown when present. */
  explanation?: string | null;
}

export interface KbDoubtfulPayload {
  material_id: string;
  material_title: string;
  correction_ids: string[];
}

export interface KbLinkFailedPayload {
  material_id: string;
  url: string;
  reason: string;
}

// ---- §2.1 Corrections (used by the doubtful-corrections decision) -------------------------

export interface KbCorrection {
  id: string;
  material_id: string;
  seg: number;
  before: string;
  after: string;
  reason: string;
  confidence: number | null;
  state: 'applied' | 'doubtful' | 'reverted' | 'kept';
  auto: boolean;
  created_at: string;
  decided_at: string | null;
}

export interface KbCorrectionChange {
  correction: KbCorrection;
  affected_blocks: number;
  job: KbJob | null;
}

// ---- §1.2 Search -------------------------------------------------------------------------

export interface KbMaterialHit {
  id: string;
  title: string;
  kind: MaterialKind;
  folder_id: string;
  folder_name: string;
  created_at: string;
  snippet: KbSnippetPart[];
}

export interface KbSearchCounts {
  wiki: number;
  materials: number;
  chats: number;
}

export interface KbSearchResults {
  query: string;
  fragments: KbFragmentHit[];
  blocks: KbBlockHit[];
  pages: KbPageHit[];
  materials: KbMaterialHit[];
  counts: KbSearchCounts;
}

// ---- §3 Chats ------------------------------------------------------------------------------

export interface KbPageRef {
  id: string;
  kind: PageKind;
  title: string;
}

export interface KbRef {
  type: 'page' | 'material' | 'chat';
  id: string;
  title: string;
}

export interface KbQuote {
  source: 'page' | 'material' | 'chat';
  id: string;
  block_id?: string | null;
  seg?: number | null;
  message_id?: string | null;
  text: string;
}

export interface KbMessageInput {
  text: string;
  mentions: KbRef[];
  quotes: KbQuote[];
  attachments: string[];
}

export interface KbFailure {
  kind: 'limit' | 'auth' | 'incompatible' | 'network' | 'cancelled' | 'other';
  message: string;
  retry_at: string | null;
}

export interface KbConnectionSide {
  folder_id: string;
  folder_name: string;
  text: string;
  citation: KbCitation;
}

export type KbMessagePart =
  | { type: 'text'; text: string }
  | { type: 'cite'; citation: KbCitation }
  | { type: 'page'; page: KbPageRef; block_id: string | null }
  | { type: 'connection'; folders: KbConnectionSide[]; inference: string; page: KbPageRef | null }
  | { type: 'tool'; name: string; label: string };

export type MessageState = 'streaming' | 'done' | 'interrupted' | 'failed' | 'cancelled';

export interface KbMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  created_at: string;
  engine: EngineId | null;
  model: string | null;
  state: MessageState;
  parts: KbMessagePart[];
  failure: KbFailure | null;
  saved_page_id: string | null;
  input: KbMessageInput | null;
}

export interface KbChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  engine: EngineId;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
  last_preview: string;
  recording_material_id: string | null;
  folder_ids: string[];
  state: 'idle' | 'answering';
  unread: boolean;
}

export interface KbChat extends KbChatSummary {
  messages: KbMessage[];
  cursor: number;
}

export interface KbChatCreate {
  title?: string | null;
  engine?: EngineId | null;
  model?: string | null;
  effort?: string | null;
  recording_material_id?: string | null;
}

export interface KbChatUpdate {
  title?: string | null;
  pinned?: boolean | null;
  engine?: EngineId | null;
  model?: string | null;
  effort?: string | null;
}

export interface KbSendContext {
  open_page_id?: string | null;
  open_material_id?: string | null;
}

export interface KbSend {
  text: string;
  mentions: KbRef[];
  quotes: KbQuote[];
  attachments: string[];
  context: KbSendContext;
}

export interface KbSendResult {
  user: KbMessage;
  assistant: KbMessage;
}

export interface KbChatEvent {
  seq: number;
  type: 'message' | 'delta' | 'part' | 'state' | 'title';
  message_id: string;
  text?: string | null;
  part?: KbMessagePart | null;
  message?: KbMessage | null;
}

export interface KbChatEvents {
  events: KbChatEvent[];
  cursor: number;
}

export interface KbChatListEvents {
  chats: KbChatSummary[];
  cursor: number;
}

export interface KbChatExport {
  file_name: string;
  markdown: string;
}

export interface KbMentions {
  pages: KbPageRef[];
  materials: KbRef[];
  chats: KbRef[];
}

// ---- §4 S3 settings ------------------------------------------------------------------------

export type HealthSectionId = 'accounts' | 'models' | 'speech' | 'wiki' | 'storage' | 'privacy' | 'appearance' | 'about';

export interface KbProblemAction {
  id: string;
  label: string;
  primary: boolean;
}

export interface KbProblem {
  id: string;
  severity: 'warning' | 'error' | 'progress';
  title: string;
  reason: string;
  still_works: string;
  stopped: string;
  progress: number | null;
  actions: KbProblemAction[];
}

export interface KbHealthSection {
  id: HealthSectionId;
  state: 'ok' | 'progress' | 'warning' | 'error';
  problems: KbProblem[];
}

export interface KbSettingsHealth {
  sections: KbHealthSection[];
}

export type KeyProviderId = 'openrouter' | 'soniox' | 'openai';

export interface KbKeyProvider {
  id: KeyProviderId;
  configured: boolean;
  checked_at: string | null;
  valid: boolean | null;
}

export interface KbSettingsKeys {
  providers: KbKeyProvider[];
}

export interface KbKeyUpdate {
  key: string;
}

export interface KbLocalModel {
  state: 'missing' | 'downloading' | 'ready' | 'failed';
  progress: number | null;
  reason: string | null;
}

export interface KbSpeechSettings {
  provider: 'soniox' | 'local_whisper';
  languages: string[];
  translate_by_default: boolean;
  translation_language: string;
  local_model: KbLocalModel;
}

export interface KbSpeechSettingsUpdate {
  provider?: 'soniox' | 'local_whisper';
  languages?: string[];
  translate_by_default?: boolean;
  translation_language?: string;
}

export interface KbPrivacyFlow {
  what: string;
  where: string;
  when: string;
  enabled: boolean;
}

export interface KbPrivacy {
  flows: KbPrivacyFlow[];
}

export interface KbLicense {
  name: string;
  license: string;
  url: string;
}

export interface KbAbout {
  version: string;
  build: string;
  licenses: KbLicense[];
}

export interface KbDictation {
  text: string;
  language: string;
  provider: string;
}

/** `/kb/settings/wiki` with the W2 fields (§2.1 auto_corrections, §2.5 background_connections). */
export interface KbWikiSettings extends KbWikiSettingsB1 {
  auto_corrections: boolean;
  background_connections: boolean;
}

export interface KbWikiSettingsUpdate extends KbWikiSettingsUpdateB1 {
  auto_corrections?: boolean | null;
  background_connections?: boolean | null;
}

// ---- §4 Hermes first run (B10) -------------------------------------------------------------

export type AgentState = 'ready' | 'not_installed' | 'outdated' | 'signed_out' | 'unavailable' | 'preparing';

export interface KbAgentFirstRun {
  required_bytes: number;
  prepared: boolean;
  note: string;
}

export interface KbAgent {
  id: EngineId;
  name: string;
  state: AgentState;
  installed: boolean;
  version: string | null;
  min_version: string;
  signed_in: boolean;
  incompatible: boolean;
  reason: string | null;
  action: 'install' | 'update' | 'login' | 'check' | null;
  models: KbAgentModel[];
  current_model: string | null;
  install: KbAgentInstallInfo;
  install_task: string | null;
  checked_at: string;
  /** Hermes only (S3, B10); null for the others. */
  first_run?: KbAgentFirstRun | null;
}

export interface KbAgents {
  agents: KbAgent[];
  default: EngineId;
}

export interface KbInstallTask {
  id: string;
  engine: EngineId;
  action: 'install' | 'update' | 'prepare';
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  lines: KbInstallLine[];
  cursor: number;
  dropped: number;
  reason: string | null;
  version: string | null;
  install: KbAgentInstallInfo;
  started_at: string;
  finished_at: string | null;
}

// ---- Endpoint map ----------------------------------------------------------------------------

type None = Record<string, never>;
type E<P, Q, B, R, S extends number = 200> = { path: P; query: Q; body: B; response: R; status: S };
type ChatPath = { chat_id: string };
type MsgPath = { chat_id: string; message_id: string };

export interface B2Endpoints {
  // Chats (C1)
  'GET /kb/chats': E<None, { q?: string; filter?: 'all' | 'pinned' | 'recording'; folder_id?: string; limit?: number }, never, KbChatSummary[]>;
  'POST /kb/chats': E<None, None, KbChatCreate, KbChat, 201>;
  'GET /kb/chats/events': E<None, { after?: number; wait?: number }, never, KbChatListEvents>;
  'GET /kb/chats/{chat_id}': E<ChatPath, None, never, KbChat>;
  'PATCH /kb/chats/{chat_id}': E<ChatPath, None, KbChatUpdate, KbChatSummary>;
  'DELETE /kb/chats/{chat_id}': E<ChatPath, None, never, void, 204>;
  'POST /kb/chats/{chat_id}/messages': E<ChatPath, None, KbSend, KbSendResult, 202>;
  'GET /kb/chats/{chat_id}/events': E<ChatPath, { after?: number; wait?: number }, never, KbChatEvents>;
  'POST /kb/chats/{chat_id}/messages/{message_id}/stop': E<MsgPath, None, never, KbMessage>;
  'POST /kb/chats/{chat_id}/messages/{message_id}/regenerate': E<MsgPath, None, never, KbSendResult, 202>;
  'POST /kb/chats/{chat_id}/messages/{message_id}/resume': E<MsgPath, None, never, KbSendResult, 202>;
  'POST /kb/chats/{chat_id}/messages/{message_id}/save': E<MsgPath, None, never, KbPageRef>;
  'POST /kb/chats/{chat_id}/save': E<ChatPath, None, never, KbPageRef>;
  'GET /kb/chats/{chat_id}/export': E<ChatPath, None, never, KbChatExport>;
  'POST /kb/chats/{chat_id}/read': E<ChatPath, None, never, void, 204>;
  'GET /kb/mentions': E<None, { q?: string; limit?: number }, never, KbMentions>;
  // Notifications (W2)
  'GET /kb/notifications': E<None, { include_dismissed?: boolean; after?: number; wait?: number }, never, KbNotificationFeed>;
  'POST /kb/notifications/{notification_id}/resolve': E<{ notification_id: string }, None, KbResolve, KbNotification>;
  'POST /kb/notifications/{notification_id}/dismiss': E<{ notification_id: string }, None, never, KbNotification>;
  'POST /kb/notifications/read': E<None, None, KbNotificationsRead, void, 204>;
  'GET /kb/materials/{material_id}/corrections': E<{ material_id: string }, None, never, KbCorrection[]>;
  'POST /kb/corrections/{correction_id}/accept': E<{ correction_id: string }, None, never, KbCorrectionChange>;
  'POST /kb/corrections/{correction_id}/keep': E<{ correction_id: string }, None, never, KbCorrectionChange>;
  'GET /kb/materials/{material_id}/excluded': E<{ material_id: string }, None, never, KbMaterialGuard>;
  'POST /kb/materials/{material_id}/excluded/{seg}/restore': E<{ material_id: string; seg: number }, None, never, KbMaterialGuard>;
  // Search (S3)
  'GET /kb/search': E<None, { q: string; limit?: number }, never, KbSearchResults>;
  // Settings (S3, W2)
  'GET /kb/settings/health': E<None, None, never, KbSettingsHealth>;
  'POST /kb/settings/health/{problem_id}/{action_id}': E<{ problem_id: string; action_id: string }, None, never, KbSettingsHealth>;
  'GET /kb/settings/keys': E<None, None, never, KbSettingsKeys>;
  /** Response shape is not fixed by the contract; the UI reads the keys again afterwards. */
  'PUT /kb/settings/keys/{provider}': E<{ provider: KeyProviderId }, None, KbKeyUpdate, unknown>;
  'POST /kb/settings/keys/{provider}/check': E<{ provider: KeyProviderId }, None, never, KbKeyProvider>;
  'GET /kb/settings/speech': E<None, None, never, KbSpeechSettings>;
  'PUT /kb/settings/speech': E<None, None, KbSpeechSettingsUpdate, KbSpeechSettings>;
  'GET /kb/settings/privacy': E<None, None, never, KbPrivacy>;
  'GET /kb/settings/about': E<None, None, never, KbAbout>;
  'GET /kb/settings/wiki': E<None, None, never, KbWikiSettings>;
  'PUT /kb/settings/wiki': E<None, None, KbWikiSettingsUpdate, KbWikiSettings>;
  'POST /kb/wiki/connections/find': E<None, None, never, KbJob, 202>;
  // Agents (A2 + S3 first run)
  'GET /kb/agents': E<None, None, never, KbAgents>;
  'PUT /kb/agents/default': E<None, None, KbAgentDefault, KbAgents>;
  'POST /kb/agents/{engine}/check': E<{ engine: EngineId }, None, never, KbAgent>;
  'POST /kb/agents/{engine}/install': E<{ engine: EngineId }, None, KbInstallStart | null, KbInstallTask, 202>;
  'POST /kb/agents/{engine}/login': E<{ engine: EngineId }, None, KbAgentLogin | null, KbAgentLoginResult>;
  'GET /kb/agents/install/{task_id}': E<{ task_id: string }, { after?: number; wait?: number }, never, KbInstallTask>;
  'POST /kb/agents/install/{task_id}/cancel': E<{ task_id: string }, None, never, KbInstallTask>;
  // Decisions (D1) — unchanged, listed for completeness of the settings screen
  'GET /kb/decisions': E<None, None, never, KbDecisions>;
  'PUT /kb/decisions/provider': E<None, None, KbDecisionProviderUpdate, KbDecisions>;
  'POST /kb/decisions/local/download': E<None, None, never, KbDecisions, 202>;
  'POST /kb/decisions/local/cancel': E<None, None, never, KbDecisions>;
}
