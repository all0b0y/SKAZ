// Shapes of the native PCM bridge (electron/nativeLive.ts ↔ the backend's /sessions/{id}/live/stream).

export interface NativeAudioMeta {
  sequence: number;
  startSample: number;
}

export interface NativeOpened {
  audio_retained?: boolean;
  connection_id: string;
  sample_rate: number;
  saved_samples: number;
  next_sequence: number;
  transcription: 'connecting' | 'unavailable' | 'disabled';
  /** Which provider transcribes this stream (soniox, local-whisper, openai). */
  transcription_provider?: string;
  /** Sanitized reason transcription is unavailable, when the backend knows it. */
  transcription_detail?: string;
}

export interface NativeSaved {
  sequence: number;
  saved_samples: number;
  duplicate: boolean;
}

export interface NativeStopped {
  saved_samples: number;
  transcription_complete: boolean;
  transcription_pending?: boolean;
  /** Backend's specific reason when transcription_complete is false. */
  transcription_detail?: string;
  status: 'paused' | 'stopped';
}

export interface NativeFailure {
  sessionId: string;
  code: 'native_stream_failed' | 'invalid_stream' | 'storage_failed' | 'transcription_failed';
  /** Sanitized provider reason for transcription_failed (e.g. "Local Whisper cannot keep up…"). */
  reason?: string;
}
