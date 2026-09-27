// Wire types mirror docs/API.md exactly: snake_case, string IDs, integer ms
// on the recording timeline (pauses excluded). Additional fields are allowed
// by the contract, so these interfaces are intentionally non-exhaustive shapes
// of the fields the UI relies on.

export type ProviderName =
  | 'local-whisper'
  | 'local-gigachat-mlx'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'claude-code';

export type TaskKind = 'asr' | 'agent' | 'notes' | 'embedding';
export type LocalProviderName = 'local-whisper' | 'local-gigachat-mlx';
export type CloudProviderName = 'openrouter' | 'openai' | 'anthropic' | 'soniox';

export type SessionStatus = 'recording' | 'paused' | 'stopped';
export type SessionMode = 'legacy' | 'contextual_local';
export type NativeRecordingMode = 'transcription' | 'translation' | 'audio_only';

export interface StorageRootView {
  root: string | null;
  suggested_root: string;
  managed: boolean;
  change_locked: boolean;
  mode: 'markdown_projection';
}

export interface SessionFileEntry {
  name: string;
  path: string;
  state: 'written' | 'unchanged' | 'conflict' | 'conflict_recovered' | 'recovery_required';
}

/** Last persisted projection result, not a live filesystem audit or audio status. */
export interface SessionFilesStatus {
  state: 'disabled' | 'pending' | 'ready' | 'conflict' | 'error' | 'missing';
  directory?: string;
  files: SessionFileEntry[];
  conflicts?: SessionFileEntry[];
  source_version?: string;
  preserved_directories?: string[];
  preservation_pending?: boolean;
  error?: string;
}

/** Optional PATCH /sessions/{id} lifecycle controls. Omission preserves legacy flushing. */
export interface SessionStatusOptions {
  title?: string;
  flush_transcription?: boolean;
}

export type ChatScope = 'session' | 'group' | 'all';

export interface Profile {
  provider: ProviderName;
  model: string;
}

export interface Settings {
  used_languages?: string[] | null;
  supported_languages?: string[];
  /** Stored next-recording preferences; capture wiring is a separate contract. */
  native_recording_mode?: NativeRecordingMode;
  translation_target_language?: string;
  /** Preferred microphone (browser deviceId); null = the system default. */
  input_device_id?: string | null;
  /** Mix whole-system audio into the next recording (macOS 14.2+). */
  capture_system_audio?: boolean;

  /** Key presence per cloud provider; a key belongs to the provider, not to a task. */
  provider_has_api_key?: Partial<Record<CloudProviderName, boolean>>;
  asr: Profile;
  agent: Profile;
  notes: Profile;
  embedding?: Profile;
  transcript_language: string; // "auto" or a language code
  output_language: string;
  cloud_consent: boolean;
  /** Optional embedding cost cap per question. Null disables; omitted preserves on update. */
  embedding_budget_usd?: number | null;
  /** Warn when an import's estimated cost exceeds this many US dollars; null disables. */
  import_cost_warning_usd?: number | null;
  /** Explicit opt-in for the experimental contextual local mode; off by default. */
  contextual_local_enabled: boolean;
  /** Proactive assistant (a card when someone asks you something); off by default. */
  proactive?: ProactiveSettings;
}

/** Noticing a direct question to the user in a live session. */
export interface ProactiveSettings {
  enabled: boolean;
  /** Names, nicknames and code phrases that count as addressing the user. */
  aliases: string[];
  /** Sound for the out-of-focus system notification. */
  sound: boolean;
  /** Consent to send transcript text to the selected Assistant model automatically. */
  model_consent: boolean;
}

export type ProactiveCardStatus = 'listening' | 'answering' | 'answered' | 'no_answer' | 'failed' | 'stopped';

export interface ProactiveWebResult { title: string; url: string; description: string }

export interface ProactiveCard {
  id: string;
  session_id: string;
  status: ProactiveCardStatus;
  /** "possible" when the recogniser left it unclear whether you were addressed. */
  addressed: 'direct' | 'possible';
  /** The question exactly as it was heard. */
  question: string;
  question_citation: Citation;
  /** What was said just before the question. */
  context_citations: Citation[];
  finished: boolean;
  /** Model summary of the context, every sentence citing the transcript ([P<n>]). */
  context: string;
  /** Draft answer built only from what was said, cited. Empty when there is none. */
  answer: string;
  /** What the recording does not say that the answer would need. */
  missing: string;
  /** The assistant's own addition — not said in the session. */
  outside_recording: string;
  citations: Citation[];
  notice: string | null;
  model: string;
  /** The question without your names: a starting point for a web lookup. */
  public_query: string;
  web: {
    query: string;
    status: 'awaiting_approval' | 'completed' | 'declined' | 'failed';
    results: ProactiveWebResult[];
    error: string | null;
  } | null;
  revision: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  answered_at: string | null;
  timings: { detect_ms: number | null; answer_ms: number | null };
}

export interface ProactiveView {
  enabled: boolean;
  /** False for imported recordings: they never trigger the proactive assistant. */
  live: boolean;
  session_enabled: boolean;
  sound: boolean;
  version: number;
  /** Newest first. */
  cards: ProactiveCard[];
}

/** Partial update body for PUT /settings. Credentials never live in a profile. */
export interface ProfileUpdate {
  provider?: ProviderName;
  model?: string;
}

export interface SettingsUpdate {
  used_languages?: string[];
  native_recording_mode?: NativeRecordingMode;
  translation_target_language?: string;
  /** "" resets to the system default microphone. */
  input_device_id?: string;
  capture_system_audio?: boolean;

  /** Write-only provider keys. Omitted provider preserves; empty string removes. */
  provider_keys?: Partial<Record<CloudProviderName, string>>;
  asr?: ProfileUpdate;
  agent?: ProfileUpdate;
  notes?: ProfileUpdate;
  embedding?: ProfileUpdate;
  transcript_language?: string;
  output_language?: string;
  cloud_consent?: boolean;
  embedding_budget_usd?: number | null;
  import_cost_warning_usd?: number;
  /** Explicit flag, because a bare null means "unchanged" for every other field. */
  clear_import_cost_warning?: boolean;
  /** Omitted keeps the stored value: enabling is always an explicit user action. */
  contextual_local_enabled?: boolean;
  /** Given fields replace the stored proactive settings. */
  proactive?: Partial<ProactiveSettings>;
}

/** An import in flight or settled. Mirrors backend ImportView. */
export type ImportStatus =
  | 'queued' | 'downloading' | 'preparing' | 'interrupted' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type MediaSource = { kind: 'youtube'; url: string } | { kind: 'local'; path: string };
export interface ImportPreview {
  title: string;
  duration_ms: number;
  source: MediaSource;
  existing_session_ids: string[];
}

export interface ImportSourceView {
  kind?: 'local' | 'youtube';
  url?: string | null;
  video_id?: string | null;
  name: string;
  path: string;
  size_bytes: number;
  /** False once the file moved or changed; the transcript stays usable regardless. */
  available: boolean;
}

export interface ImportView {
  session_id: string;
  status: ImportStatus;
  source: ImportSourceView;
  translate: boolean;
  model: string;
  declared_duration_ms?: number | null;
  /** What the provider billed. Only known once processing started. */
  audio_duration_ms?: number | null;
  error?: string | null;
  created_at: string;
  settled_at?: string | null;
}

export interface ImportCapabilities {
  supported_extensions: string[];
  max_duration_ms: number;
  rate_per_hour_usd: number;
  translation_rate_per_hour_usd: number;
  warn_above_usd: number | null;
  cloud_consent: boolean;
  has_api_key: boolean;
  active_imports: number;
  max_concurrent_imports: number;
  destination: string;
  markdown_enabled: boolean;
}

export interface ImportCreated {
  session: Session;
  import_state: ImportView;
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
  asr_contract?: 'dedicated' | 'legacy' | null;
  note?: string | null;
}

export interface ModelsResponse {
  models: ModelInfo[];
  error?: string;
}

// Preparation state of one known local checkpoint. Mirrors the backend
// LocalModelState (see .runtime/asr-local-contract.md). "ready" means the engine
// loads from local files with the network closed — it is NOT a quality measure.
// "dependency_missing" is deliberately distinct: the fix is installing the backend
// extra, not retrying a download. Any unrecognised future value is treated as
// "not ready for use" by the UI.
export type LocalModelState =
  | 'not_installed'
  | 'loading'
  | 'installing'
  | 'verifying'
  | 'ready'
  | 'error'
  | 'dependency_missing'
  | 'unsupported';

export interface LocalModelProgress {
  stage: 'downloading' | 'verifying';
  downloaded_bytes: number;
  completed_files: number;
  total_bytes?: number | null;
  total_files?: number | null;
}

export interface LocalModelHardware {
  physical_memory_bytes: number;
  required_memory_bytes?: number | null;
}

export interface LocalModelStatus {
  provider?: LocalProviderName;
  model: string;
  state: LocalModelState;
  // Sanitised UI text, present only for the failing states.
  error?: string | null;
  progress?: LocalModelProgress | null;
  hardware?: LocalModelHardware | null;
  cached?: boolean;
  shared_cache?: boolean;
  warning?: string | null;
  deleted?: boolean;
  deleted_bytes?: number;
  deleted_files?: number;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  status: SessionStatus;
  duration_ms: number;
  mode: SessionMode;
  origin?: 'live' | 'import';
}

/** `POST /sessions/delete`: each id is deleted independently. */
export interface BulkDeleteResult {
  deleted: string[];
  failed: { id: string; reason: string }[];
}

export interface SegmentSource {
  sequence: number;
  sample_start: number;
  sample_end: number;
  sha256: string;
  source_kind: 'original_captured_wav';
}

export interface Segment {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  language?: string;
  sources?: SegmentSource[];
}

export interface LiveAsrCapabilities {
  mode: 'contextual_local';
  capable: boolean;
  requirements: {
    local_profile_selected: boolean;
    /** The persisted user opt-in; false means the mode was never enabled in Settings. */
    contextual_local_enabled: boolean;
    /** Effective runtime capabilities: the opt-in above, or a process-level override. */
    live_finality_enabled: boolean;
    local_speech_gate_enabled: boolean;
  };
  detail: string;
}

export interface LiveAsrSource {
  sequence: number;
  start_ms: number;
  end_ms: number;
  sample_rate: number;
  sample_count: number;
  window_sample_start: number;
  window_sample_end: number;
  sha256: string;
  source_kind: 'original_captured_wav';
}

export interface LiveAsrDraft {
  state: 'draft';
  revision: number;
  epoch: number;
  updated_at: string;
  text: string;
  text_scope?: 'unstable_tail' | 'whole_window';
  language?: string | null;
  provider: 'local-whisper';
  model: string;
  requested_language: string;
  speech_gate_enabled: boolean;
  source_fingerprint: string;
  config_fingerprint: string;
  config_revision: number;
  window: {
    start_ms: number; end_ms: number; sample_rate: number; sample_count: number;
    model_input_sample_rate: number; model_input_sample_count: number;
    model_input_kind: 'assembled_pcm16_mono_resampled_for_local_whisper';
  };
  sources: LiveAsrSource[];
  finality?: {
    enabled: boolean;
    status: 'disabled' | 'awaiting_agreement' | 'stable' | 'advanced' | 'blocked';
    blocked_reason?: string | null;
    stable_frontier_ms: number;
  };
}

export interface LiveAsrResponse {
  draft: LiveAsrDraft | null;
  finalized_segments?: Segment[];
  source_integrity?: LiveAsrSourceIntegrity;
  resume_compatibility?: LiveAsrResumeCompatibility;
}

export interface LiveAsrSourceIntegrity {
  status: 'verified' | 'missing' | 'corrupt';
  trusted: boolean;
  detail?: string | null;
}

export interface LiveAsrResumeCompatibility {
  status: 'compatible' | 'config_changed' | 'source_unavailable';
  can_resume: boolean;
  requires_redecode: boolean;
  detail?: string | null;
}

export interface LiveAsrSchedulerStatus {
  capable: boolean;
  accepted_count: number;
  status: 'idle' | 'scheduled' | 'running' | 'stalled' | 'complete' | 'stopped';
  captured_target_sequence: number | null;
  processed_window: {
    first_sequence: number; last_sequence: number; start_ms: number; end_ms: number;
  } | null;
  stable_frontier_ms: number;
  lag_ms: number | null;
  block_reason: string | null;
  source_ended?: boolean;
  recovery_required?: boolean;
  available_audio_processed?: boolean;
  source_continuity_verified?: boolean;
}

export interface LiveAsrAdvanceResponse {
  accepted: true;
  scheduler: LiveAsrSchedulerStatus;
}

export type LiveAsrFragmentState = 'open' | 'complete' | 'error';
export type LiveAsrFragmentIntegrity = 'verified' | 'missing' | 'corrupt';

export interface LiveAsrFragment {
  fragment_id: string;
  ordinal: number;
  start_ms: number;
  observed_end_ms: number;
  protected_through_ms: number;
  text: string;
  language?: string | null;
  state: LiveAsrFragmentState;
  state_reason?: string | null;
  revision: number;
  draft_revision: number;
  config_revision: number;
  range_fingerprint: string;
  protected: boolean;
  completion_provenance?: 'live_agreement' | 'source_ended_final_pass' | 'ordinary_recovery' | null;
  segment_id?: string | null;
  accepted_at?: string | null;
  source_integrity: LiveAsrFragmentIntegrity;
  sources: SegmentSource[];
  can_edit: boolean;
  edit_disabled_reason?: string | null;
  can_accept: boolean;
  accept_disabled_reason?: string | null;
}

export interface EditLiveAsrFragmentRequest {
  text: string;
  expected_revision: number;
  range_fingerprint: string;
}

export interface AcceptLiveAsrFragmentRequest {
  expected_revision: number;
  range_fingerprint: string;
  idempotency_key: string;
}

export interface Citation {
  session_id?: string | null;
  session_title?: string | null;
  segment_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  /**
   * Where this citation points as a unit of speech: one monologue and a token range
   * inside it. The monologue's displayed number is worked out against the current
   * transcript, never stored, so an edit elsewhere cannot silently move what a note
   * claims to rest on. Absent on citations made before monologues existed.
   */
  monologue_id?: string | null;
  start_token_id?: string | null;
  end_token_id?: string | null;
  speaker?: number | null;
  /**
   * Assistant answers only: the prompt labels (`P3`) that resolved to this source.
   * The answer text keeps those labels, so each footnote lands where it was cited.
   * Empty/absent on answers saved before the backend recorded it.
   */
  labels?: string[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  citations?: Citation[];
  /** Codex answer generated again from scratch after its run was interrupted. */
  restarted?: boolean;
}

export interface Note {
  id?: string;
  revision?: number;
  source_revision?: number | null;
  stale?: boolean;
  content: string;
  /** The note's own name. Empty means: fall back to the document's first line. */
  title?: string;
  created_at: string;
  /** Last accepted write — what the notes list is ordered by. */
  updated_at?: string;
  model: string;
  citations: Citation[];
}

/** How dense generated notes should be. Density only — never how firmly they rest on speech. */
export type NoteDetail = 'brief' | 'normal' | 'detailed';

/**
 * A written replacement for one passage, waiting for the user's decision.
 *
 * Nothing is stored until it is applied: the point of the preview is that a
 * rewrite can be read beside the original and refused.
 */
export interface RewritePreview {
  id: string;
  note_id: string;
  revision: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
  citations: Citation[];
}

export interface SessionDetail {
  session: Session;
  segments: Segment[];
  messages: Message[];
  notes: Note | null;
  notes_list?: Note[];
  /** Server-computed: the notes generator has final speech to read. */
  has_transcript?: boolean;
}

export interface AudioIngestResponse {
  segments: Segment[];
  duplicate: boolean;
}

export interface BufferedAudioResponse {
  sequence: number;
  start_ms: number;
  end_ms: number;
  status: AudioChunkStatus;
  available: boolean;
  duplicate: boolean;
  source_kind: 'original_captured_wav';
}

export type AudioChunkStatus = 'pending' | 'failed' | 'done';

/** One persisted captured WAV entry. Availability is independent of ASR status. */
export interface AudioChunkManifest {
  sequence: number;
  start_ms: number;
  end_ms: number;
  status: AudioChunkStatus;
  available: boolean;
  segment_ids: string[];
  source_kind: 'original_captured_wav';
}

export interface AudioManifestPage {
  chunks: AudioChunkManifest[];
  next_after_sequence: number | null;
}

export interface AskContext {
  search_scope?: ChatScope | null;
  session_count?: number;
  source_count?: number;
  selected_count?: number;
  truncated?: boolean;
  retrieval?: 'legacy' | 'hybrid' | 'monologues' | 'lexical';
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
  search_scope?: ChatScope;
  group_session_ids?: string[];
  language?: string;
}
