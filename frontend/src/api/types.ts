// Wire types mirror docs/API.md exactly: snake_case, string IDs, integer ms
// on the recording timeline (pauses excluded). Additional fields are allowed
// by the contract, so these interfaces are intentionally non-exhaustive shapes
// of the fields the UI relies on.

export type SessionStatus = 'recording' | 'paused' | 'stopped';
export type SessionMode = 'legacy' | 'contextual_local';
export type NativeRecordingMode = 'transcription' | 'translation' | 'audio_only';

/** Optional PATCH /sessions/{id} lifecycle controls. Omission preserves legacy flushing. */
export interface SessionStatusOptions {
  title?: string;
  flush_transcription?: boolean;
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
