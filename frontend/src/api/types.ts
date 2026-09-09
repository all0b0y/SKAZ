// Wire types mirror docs/API.md exactly: snake_case, string IDs, integer ms
// on the recording timeline (pauses excluded). Additional fields are allowed
// by the contract, so these interfaces are intentionally non-exhaustive shapes
// of the fields the UI relies on.

export type ProviderName =
  | 'local-whisper'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'claude-code';

export type TaskKind = 'asr' | 'agent' | 'notes';

export type SessionStatus = 'recording' | 'paused' | 'stopped';

export type ChatScope = 'auto' | 'recent' | 'all' | 'beginning' | 'search';

export interface Profile {
  provider: ProviderName;
  model: string;
  base_url?: string;
  has_api_key?: boolean;
}

export interface Settings {
  asr: Profile;
  agent: Profile;
  notes: Profile;
  transcript_language: string; // "auto" or a language code
  output_language: string;
  cloud_consent: boolean;
}

/** Partial update body for PUT /settings. api_key is write-only. */
export interface ProfileUpdate {
  provider?: ProviderName;
  model?: string;
  base_url?: string;
  api_key?: string;
}

export interface SettingsUpdate {
  asr?: ProfileUpdate;
  agent?: ProfileUpdate;
  notes?: ProfileUpdate;
  transcript_language?: string;
  output_language?: string;
  cloud_consent?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  input_modalities: string[];
  // Mirrors the backend CatalogModel.output_modalities. Optional so a stale or
  // partial catalog response (missing the field) is retained rather than dropped;
  // an explicit non-text list lets a text picker exclude image/audio/video-only models.
  output_modalities?: string[];
  verified: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  error?: string;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  status: SessionStatus;
  duration_ms: number;
}

export interface Segment {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  language?: string;
}

export interface Citation {
  segment_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  citations?: Citation[];
}

export interface Note {
  content: string;
  created_at: string;
  model: string;
  citations: Citation[];
}

export interface SessionDetail {
  session: Session;
  segments: Segment[];
  messages: Message[];
  notes: Note | null;
}

export interface AudioIngestResponse {
  segments: Segment[];
  duplicate: boolean;
}

export interface AskContext {
  start_ms: number;
  end_ms: number;
  scope: string;
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  context: AskContext;
  model: string;
}

export interface AskRequest {
  question: string;
  window_minutes?: number;
  scope?: ChatScope;
  language?: string;
}
