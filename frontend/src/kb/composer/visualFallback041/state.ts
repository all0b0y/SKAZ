import type { EngineId } from '../../api/names';
import {
  TEXT_ONLY_DISCLOSURE,
  UNSUPPORTED_CARD_TITLE,
  type CompatibleModelHint,
  type UnsupportedVisualReason,
  type UnsupportedVisualResult,
  type VisualCapabilityDecision,
  type VisualFallbackSeam,
  type VisualSourceKind,
  type VisualSourceLocator,
} from './types';

function isDecisionVerified(decision: VisualCapabilityDecision): boolean {
  return (
    decision.supported
    && decision.state === 'supported'
    && decision.transportSupportsImage
    && decision.modelSupportsImage === true
    && Boolean(decision.modelId && decision.modelId.trim())
  );
}

function locatorsMatch(expected: VisualSourceLocator, actual: VisualSourceLocator): boolean {
  return (
    Boolean(expected.materialId.trim())
    && expected.materialId === actual.materialId
    && expected.sourceKind === actual.sourceKind
    && expected.page === actual.page
    && expected.timestampMs === actual.timestampMs
  );
}

export interface DraftVisualFallbackState {
  seam: VisualFallbackSeam;
  draftText: string;
  attachmentKeys: readonly string[];
  locator?: VisualSourceLocator;
  requestKey?: string;
}

export type DraftFallbackMap = Readonly<Record<string, DraftVisualFallbackState>>;

export type ComposerSubmitGate =
  | { action: 'send_normal'; disclosure: null }
  | { action: 'send_with_visual'; disclosure: null }
  | { action: 'send_text_only'; disclosure: typeof TEXT_ONLY_DISCLOSURE }
  | { action: 'block_show_fallback'; disclosure: null };

export function unsupportedDetailForSource(
  sourceKind: VisualSourceKind,
  textOnlyAvailable: boolean,
  customDetail?: string | null,
): string {
  if (customDetail) return customDetail;
  if (sourceKind === 'local_video') {
    return 'SKAZ transcribes the audio only. It doesn’t save the video or its frames.';
  }
  if (sourceKind === 'pdf') {
    return textOnlyAvailable
      ? 'The PDF text is still available.'
      : 'This PDF has no readable text layer to use instead.';
  }
  if (sourceKind === 'video_link') {
    return textOnlyAvailable
      ? 'The video transcript is still available.'
      : 'No video transcript is available to use instead.';
  }
  return textOnlyAvailable
    ? 'Accompanying text is still available.'
    : 'This attachment has no text to use instead.';
}

function titleForReason(reasonCode: UnsupportedVisualReason): string {
  if (reasonCode === 'source_not_permitted') return 'Image access is not permitted';
  if (reasonCode === 'local_video_no_frames') return 'Video frames are unavailable';
  if (
    reasonCode === 'source_mismatch'
    || reasonCode === 'payload_too_large'
    || reasonCode === 'invalid_media_type'
    || reasonCode === 'empty_payload'
    || reasonCode === 'missing_payload'
  ) {
    return 'Image couldn’t be sent';
  }
  return UNSUPPORTED_CARD_TITLE;
}

export function createUnsupportedResult({
  reasonCode,
  decision,
  locator,
  textOnlyAvailable,
  compatibleModels = [],
  customDetail,
}: {
  reasonCode?: UnsupportedVisualReason;
  decision: VisualCapabilityDecision;
  locator: VisualSourceLocator;
  textOnlyAvailable: boolean;
  compatibleModels?: readonly CompatibleModelHint[];
  customDetail?: string | null;
}): UnsupportedVisualResult {
  const code = reasonCode ?? decision.reasonCode ?? 'model_capability_unverified';
  return {
    ok: false,
    reasonCode: code,
    title: titleForReason(code),
    detail: unsupportedDetailForSource(locator.sourceKind, textOnlyAvailable, customDetail),
    engine: decision.engine,
    modelId: decision.modelId,
    sourceKind: locator.sourceKind,
    sourceLabel: locator.label || locator.materialId,
    textOnlyAvailable,
    compatibleModels: [...compatibleModels],
    draftPreserved: true,
  };
}

export function createFallbackSeam({
  decision,
  locator,
  textOnlyAvailable,
  compatibleModels = [],
  reasonCode,
  customDetail,
}: {
  decision: VisualCapabilityDecision;
  locator: VisualSourceLocator;
  textOnlyAvailable: boolean;
  compatibleModels?: readonly CompatibleModelHint[];
  reasonCode?: UnsupportedVisualReason;
  customDetail?: string | null;
}): VisualFallbackSeam {
  const verified = isDecisionVerified(decision);
  const blocked = !verified || Boolean(reasonCode) || locator.sourceKind === 'local_video';
  const effectiveReason: UnsupportedVisualReason | undefined =
    reasonCode
    ?? (locator.sourceKind === 'local_video'
      ? 'local_video_no_frames'
      : (decision.reasonCode ?? (!decision.modelId?.trim() ? 'model_not_selected' : undefined)));

  return {
    decision,
    unsupported: blocked
      ? createUnsupportedResult({
          reasonCode: effectiveReason,
          decision,
          locator,
          textOnlyAvailable,
          compatibleModels,
          customDetail,
        })
      : null,
    textOnlyAvailable,
    textOnlyChosen: false,
    draftPreserved: true,
    answerDisclosure: null,
  };
}

/**
 * Updates the model capability decision for an affected draft while preserving the typed draft
 * and attachments. Never triggers auto-send.
 */
export function selectModelPreservingDraft(
  state: DraftVisualFallbackState,
  nextDecision: VisualCapabilityDecision,
): { state: DraftVisualFallbackState; autoSend: false } {
  const prevUnsupported = state.seam.unsupported;
  const sourcePermittedBlock = prevUnsupported?.reasonCode === 'source_not_permitted'
    || prevUnsupported?.reasonCode === 'source_mismatch'
    || prevUnsupported?.reasonCode === 'local_video_no_frames';

  if (isDecisionVerified(nextDecision) && !sourcePermittedBlock) {
    return {
      autoSend: false,
      state: {
        ...state,
        seam: {
          decision: nextDecision,
          unsupported: null,
          textOnlyAvailable: state.seam.textOnlyAvailable,
          textOnlyChosen: false,
          draftPreserved: true,
          answerDisclosure: null,
        },
      },
    };
  }

  const nextUnsupported: UnsupportedVisualResult = prevUnsupported
    ? {
        ...prevUnsupported,
        engine: nextDecision.engine,
        modelId: nextDecision.modelId,
        reasonCode: sourcePermittedBlock
          ? prevUnsupported.reasonCode
          : (nextDecision.reasonCode ?? 'model_capability_unverified'),
        title: sourcePermittedBlock
          ? prevUnsupported.title
          : titleForReason(nextDecision.reasonCode ?? 'model_capability_unverified'),
      }
    : {
        ok: false,
        reasonCode: nextDecision.reasonCode ?? 'model_capability_unverified',
        title: titleForReason(nextDecision.reasonCode ?? 'model_capability_unverified'),
        detail: unsupportedDetailForSource(
          state.locator?.sourceKind ?? 'image',
          state.seam.textOnlyAvailable,
        ),
        engine: nextDecision.engine,
        modelId: nextDecision.modelId,
        sourceKind: state.locator?.sourceKind ?? 'image',
        sourceLabel: state.locator?.label || state.locator?.materialId || 'Attachment',
        textOnlyAvailable: state.seam.textOnlyAvailable,
        compatibleModels: [],
        draftPreserved: true,
      };

  return {
    autoSend: false,
    state: {
      ...state,
      seam: {
        decision: nextDecision,
        unsupported: nextUnsupported,
        textOnlyAvailable: state.seam.textOnlyAvailable,
        textOnlyChosen: false,
        draftPreserved: true,
        answerDisclosure: null,
      },
    },
  };
}

/** Transitions to text-only continuation ONLY when source text exists and the user explicitly chose it. */
export function requestTextOnlySend(
  seam: VisualFallbackSeam,
  explicitUserChoice: boolean,
): VisualFallbackSeam {
  if (!explicitUserChoice) {
    throw new Error('Text-only continuation requires an explicit user choice.');
  }
  if (!seam.textOnlyAvailable) {
    throw new Error('Text-only continuation requires available source text.');
  }
  return {
    ...seam,
    textOnlyChosen: true,
    answerDisclosure: TEXT_ONLY_DISCLOSURE,
  };
}

export function resolveComposerSubmitGate({
  requiresVisual,
  seam,
  explicitTextOnlyChoice,
  selectedTarget,
  expectedLocator,
  seamLocator,
}: {
  requiresVisual: boolean;
  seam: VisualFallbackSeam | null;
  explicitTextOnlyChoice: boolean;
  selectedTarget?: { engine: EngineId; modelId: string | null };
  expectedLocator?: VisualSourceLocator | null;
  seamLocator?: VisualSourceLocator | null;
}): ComposerSubmitGate {
  if (!requiresVisual) {
    return { action: 'send_normal', disclosure: null };
  }
  if (!seam) {
    return { action: 'block_show_fallback', disclosure: null };
  }
  if (expectedLocator && (!seamLocator || !locatorsMatch(expectedLocator, seamLocator))) {
    return { action: 'block_show_fallback', disclosure: null };
  }
  const sourceBlocked = seam.unsupported?.reasonCode === 'source_not_permitted'
    || seam.unsupported?.reasonCode === 'source_mismatch'
    || seam.unsupported?.reasonCode === 'local_video_no_frames';
  const targetMatches = !selectedTarget || (
    Boolean(selectedTarget.modelId && selectedTarget.modelId.trim())
    && seam.decision.engine === selectedTarget.engine
    && seam.decision.modelId === selectedTarget.modelId
  );
  if (isDecisionVerified(seam.decision) && !sourceBlocked && !seam.unsupported && targetMatches) {
    return { action: 'send_with_visual', disclosure: null };
  }
  if (explicitTextOnlyChoice && seam.textOnlyAvailable) {
    return { action: 'send_text_only', disclosure: TEXT_ONLY_DISCLOSURE };
  }
  return { action: 'block_show_fallback', disclosure: null };
}

export function getDraftFallback(
  store: DraftFallbackMap,
  draftKey: string,
): DraftVisualFallbackState | null {
  return store[draftKey] ?? null;
}

export function setDraftFallback(
  store: DraftFallbackMap,
  draftKey: string,
  state: DraftVisualFallbackState,
): DraftFallbackMap {
  return { ...store, [draftKey]: state };
}

export function clearDraftFallback(
  store: DraftFallbackMap,
  draftKey: string,
): DraftFallbackMap {
  if (!(draftKey in store)) return store;
  const next = { ...store };
  delete next[draftKey];
  return next;
}
