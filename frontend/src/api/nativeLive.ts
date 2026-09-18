import type { NativeRecordingMode } from './types';

export interface NativeTranscriptToken {
  id: string;
  connection_id: string;
  segment_id: string | null;
  text: string;
  speaker_number: number | null;
  start_sample: number;
  end_sample: number;
}

export interface NativeTranslationToken {
  id: string;
  connection_id: string;
  speaker_number: number | null;
  text: string;
}

export interface NativeTranslationProjection {
  original_tokens: NativeTranscriptToken[];
  translation_tokens: NativeTranslationToken[];
  monologues: Array<{
    id: string;
    connection_id: string;
    speaker_number: number | null;
    original_token_ids: string[];
    translation_token_ids: string[];
    passthrough_token_ids: string[];
    display_token_ids: string[];
  }>;
  unassigned_translation_token_ids: string[];
  order_unavailable_connection_ids: string[];
}

export interface NativeSnapshot {
  session_id: string;
  sample_rate: number;
  saved_samples: number;
  next_sequence: number;
  audio_retained?: boolean;
  recording_mode?: NativeRecordingMode;
  translation_target_language?: string;
  used_languages?: string[] | null;
  transcription: 'connecting' | 'streaming' | 'unavailable' | 'inactive' | 'disabled';
  final_tokens?: NativeTranscriptToken[];
  live_translation_projection?: NativeTranslationProjection;
  final_translation_tokens?: NativeTranslationToken[];
  partial_translation_tokens?: Array<Omit<NativeTranslationToken, 'id'>>;
  speakers?: Array<{ connection_id: string; provider_id: string; number: number }>;
  connections: Array<{
    id: string;
    start_sample: number;
    end_sample: number | null;
    final_sample: number;
    processed_sample: number;
    status: 'active' | 'finished' | 'incomplete';
    draft_json: string;
  }>;
  gaps: Array<{ start_sample: number; end_sample: number }>;
}

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
}

export interface NativeSaved {
  sequence: number;
  saved_samples: number;
  duplicate: boolean;
}

export interface NativeStopped {
  saved_samples: number;
  transcription_complete: boolean;
  status: 'paused' | 'stopped';
}

export interface NativeFailure {
  sessionId: string;
  code: 'native_stream_failed' | 'invalid_stream' | 'storage_failed';
}
