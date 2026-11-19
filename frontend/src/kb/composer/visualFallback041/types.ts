import type { EngineId } from '../../api/names';

export type VisualSourceKind = 'image' | 'pdf' | 'video_link' | 'local_video';
export type VisualCapabilityState = 'supported' | 'unsupported' | 'unverified';

export type UnsupportedVisualReason =
  | 'source_not_permitted'
  | 'source_mismatch'
  | 'local_video_no_frames'
  | 'adapter_no_image_transport'
  | 'model_no_image_input'
  | 'model_capability_unverified'
  | 'model_not_selected'
  | 'payload_too_large'
  | 'invalid_media_type'
  | 'empty_payload'
  | 'missing_payload';

export const TEXT_ONLY_DISCLOSURE = 'Text only · Image not analysed' as const;
export const UNSUPPORTED_CARD_TITLE = 'This model can’t read images' as const;

export interface VisualSourceLocator {
  materialId: string;
  sourceKind: VisualSourceKind;
  page?: number | null;
  timestampMs?: number | null;
  label: string;
}

export interface CompatibleModelHint {
  engine: EngineId;
  modelId: string;
  label: string;
  provider?: string;
}

export interface VisualCapabilityDecision {
  engine: EngineId;
  modelId: string | null;
  state: VisualCapabilityState;
  supported: boolean;
  transportSupportsImage: boolean;
  modelSupportsImage: boolean | null;
  reasonCode?: UnsupportedVisualReason | null;
  reason?: string | null;
}

export interface UnsupportedVisualResult {
  ok: false;
  reasonCode: UnsupportedVisualReason;
  title: string;
  detail: string;
  engine: EngineId;
  modelId: string | null;
  sourceKind: VisualSourceKind;
  sourceLabel: string;
  textOnlyAvailable: boolean;
  compatibleModels: readonly CompatibleModelHint[];
  draftPreserved: true;
}

export interface VisualFallbackSeam {
  decision: VisualCapabilityDecision;
  unsupported: UnsupportedVisualResult | null;
  textOnlyAvailable: boolean;
  textOnlyChosen: boolean;
  draftPreserved: boolean;
  answerDisclosure: string | null;
}
