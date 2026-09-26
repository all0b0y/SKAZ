import type { NativeRecordingMode } from './types';
import type { NativeTranscriptToken, NativeTranslationToken } from './nativeLive';

/** A cursor is always scoped to one durable ASR connection, never global. */
export type NativeEventPageQuery = { limit?: number; project?: boolean; segment_id?: string } & (
  | { connection_id?: string; after?: never; before?: never }
  | { connection_id: string; after: number; before?: never }
  | { connection_id: string; before: number; after?: never }
);

export type NativeTranslationStatus = 'none' | 'original' | 'translation';

interface OriginalTailToken {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  speaker_number: number | null;
}

interface TranslationTailToken {
  text: string;
  connection_id: string;
  speaker_number: number | null;
}

export interface NativeTurnOwner {
  id: string;
  connection_id: string;
  speaker_number: number | null;
  start_sample: number;
}

export interface NativePageOwnership {
  owners: Record<string, NativeTurnOwner>;
  translations: Record<string, string>;
  passthrough: string[];
}

export interface NativeEventPage {
  protocol: 1;
  session_id: string;
  sample_rate: number;
  saved_samples: number;
  recording_mode: NativeRecordingMode;
  translation_target_language: string;
  connection: {
    id: string;
    start_sample: number;
    end_sample: number | null;
    status: 'active' | 'finished' | 'incomplete';
    final_sample: number;
    processed_sample: number;
  } | null;
  transcription?: import('./nativeLive').NativeSnapshot['transcription'];
  projection?: {
    available: boolean;
    groups: Record<string, NativeTurnOwner | null>;
    /** Replacement overlay; never merge provisional targets into durable groups. */
    tail_groups?: Record<string, NativeTurnOwner | null>;
    tail: { originals: NativeTranscriptToken[]; translations: NativeTranslationToken[];
      order: Array<{ id: string; translation_status: NativeTranslationStatus }>;
      projection: NativePageOwnership } | null;
  };
  through: number;
  events: Array<{
    ordinal: number;
    segment_ids: string[];
    originals: NativeTranscriptToken[];
    originals_available: boolean;
    projection?: NativePageOwnership;
    translations: NativeTranslationToken[];
    /** null means historical ordering is unknown, not an empty ordered stream. */
    order: Array<{ id: string; translation_status: NativeTranslationStatus }> | null;
  }>;
  next_after: number;
  next_before: number;
  has_newer: boolean;
  has_older: boolean;
  previous_connection_id: string | null;
  next_connection_id: string | null;
  /** Replacement, never append; withheld until the final prefix is caught up. */
  tail: {
    originals: OriginalTailToken[];
    translations: TranslationTailToken[];
    stream: Array<(OriginalTailToken | TranslationTailToken) & { translation_status: NativeTranslationStatus }>;
  } | null;
}
