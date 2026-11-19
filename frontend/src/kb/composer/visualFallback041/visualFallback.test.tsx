import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { auditCss } from '../../board/audit';
import {
  TEXT_ONLY_DISCLOSURE,
  TextOnlyDisclosure,
  VisualFallbackCard,
  clearDraftFallback,
  createFallbackSeam,
  getDraftFallback,
  requestTextOnlySend,
  resolveComposerSubmitGate,
  selectModelPreservingDraft,
  setDraftFallback,
  type DraftFallbackMap,
  type VisualCapabilityDecision,
  type VisualSourceLocator,
} from './index';

const pdfLocator: VisualSourceLocator = {
  materialId: 'mat-pdf-8',
  sourceKind: 'pdf',
  page: 8,
  label: 'Inflation report.pdf · Page 8',
};

const videoLocator: VisualSourceLocator = {
  materialId: 'mat-vid-1',
  sourceKind: 'video_link',
  timestampMs: 760_000,
  label: 'Inflation briefing · 12:40',
};

const photoLocator: VisualSourceLocator = {
  materialId: 'mat-img-1',
  sourceKind: 'image',
  label: 'Chart photo.jpg',
};

const unsupportedDecision: VisualCapabilityDecision = {
  engine: 'opencode',
  modelId: 'opencode/big-pickle',
  state: 'unsupported',
  supported: false,
  transportSupportsImage: true,
  modelSupportsImage: false,
  reasonCode: 'model_no_image_input',
  reason: 'Model Big Pickle does not accept image input.',
};

const supportedDecision: VisualCapabilityDecision = {
  engine: 'claude_code',
  modelId: 'sonnet',
  state: 'supported',
  supported: true,
  transportSupportsImage: true,
  modelSupportsImage: true,
};

describe('visualFallback041 UI-B card and non-sending state machine', () => {
  it('renders UI-B card for PDF with both Choose a model and Continue with text only, and never sends on mount or model pick', async () => {
    const user = userEvent.setup();
    const onChooseModel = vi.fn();
    const onContinueTextOnly = vi.fn();
    const seam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
    });

    render(
      <VisualFallbackCard
        id="visible-notice"
        seam={seam}
        onChooseModel={onChooseModel}
        onContinueTextOnly={onContinueTextOnly}
      />,
    );

    const card = screen.getByRole('group', { name: 'Image unavailable' });
    expect(card).toHaveAttribute('id', 'visible-notice');
    expect(card).toHaveTextContent('This model can’t read images');
    expect(card).toHaveTextContent('The PDF text is still available.');
    expect(onChooseModel).not.toHaveBeenCalled();
    expect(onContinueTextOnly).not.toHaveBeenCalled();

    const chooseBtn = within(card).getByRole('button', { name: 'Choose a model' });
    const textBtn = within(card).getByRole('button', { name: 'Continue with text only' });

    await user.click(chooseBtn);
    expect(onChooseModel).toHaveBeenCalledTimes(1);
    expect(onContinueTextOnly).not.toHaveBeenCalled();

    await user.click(textBtn);
    expect(onContinueTextOnly).toHaveBeenCalledTimes(1);
  });

  it('hides Continue with text only for photo without text and shows video transcript copy for video', () => {
    const photoSeam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: photoLocator,
      textOnlyAvailable: false,
    });
    const { rerender } = render(
      <VisualFallbackCard
        seam={photoSeam}
        onChooseModel={vi.fn()}
        onContinueTextOnly={vi.fn()}
      />,
    );

    const card = screen.getByRole('group', { name: 'Image unavailable' });
    expect(card).toHaveTextContent('This attachment has no text to use instead.');
    expect(within(card).getByRole('button', { name: 'Choose a model' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Continue with text only' })).toBeNull();

    const videoSeam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: videoLocator,
      textOnlyAvailable: true,
    });
    rerender(
      <VisualFallbackCard
        seam={videoSeam}
        onChooseModel={vi.fn()}
        onContinueTextOnly={vi.fn()}
      />,
    );
    expect(card).toHaveTextContent('The video transcript is still available.');
    expect(within(card).getByRole('button', { name: 'Continue with text only' })).toBeInTheDocument();
  });

  it('exposes chooseModelRef so blocked submit focuses Choose a model without sending', () => {
    const btnRef = createRef<HTMLButtonElement>();
    const seam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
    });
    render(
      <VisualFallbackCard
        seam={seam}
        chooseModelRef={btnRef}
        onChooseModel={vi.fn()}
        onContinueTextOnly={vi.fn()}
      />,
    );
    btnRef.current?.focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose a model' }));
  });

  it('preserves draft and attachment across model switch without auto-sending, and scopes fallback per draft', () => {
    const initial = createFallbackSeam({
      decision: unsupportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
    });

    let store: DraftFallbackMap = {};
    store = setDraftFallback(store, 'chat-1', {
      seam: initial,
      draftText: 'Explain chart on page 8',
      attachmentKeys: ['att-1'],
      locator: pdfLocator,
    });

    // Scoped only to affected draft 'chat-1', not 'chat-2'.
    expect(getDraftFallback(store, 'chat-1')?.seam.unsupported).not.toBeNull();
    expect(getDraftFallback(store, 'chat-2')).toBeNull();

    // Switching to an image-capable model preserves draftText & attachmentKeys and never auto-sends.
    const current = getDraftFallback(store, 'chat-1')!;
    const switched = selectModelPreservingDraft(current, supportedDecision);
    expect(switched.autoSend).toBe(false);
    expect(switched.state.draftText).toBe('Explain chart on page 8');
    expect(switched.state.attachmentKeys).toEqual(['att-1']);
    expect(switched.state.seam.decision.supported).toBe(true);
    expect(switched.state.seam.unsupported).toBeNull();

    // Switching back to an unsupported model restores the exact source copy without sending.
    const switchedBack = selectModelPreservingDraft(switched.state, unsupportedDecision);
    expect(switchedBack.autoSend).toBe(false);
    expect(switchedBack.state.seam.unsupported?.sourceKind).toBe('pdf');
    expect(switchedBack.state.seam.unsupported?.detail).toBe('The PDF text is still available.');

    store = clearDraftFallback(store, 'chat-1');
    expect(getDraftFallback(store, 'chat-1')).toBeNull();
  });

  it('blocks submit when unsupported, requires explicit choice + source text for text-only, and renders reply disclosure', () => {
    const pdfSeam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
    });
    expect(resolveComposerSubmitGate({ requiresVisual: true, seam: pdfSeam, explicitTextOnlyChoice: false })).toEqual({
      action: 'block_show_fallback',
      disclosure: null,
    });
    expect(() => requestTextOnlySend(pdfSeam, false)).toThrow(/explicit/i);

    const chosen = requestTextOnlySend(pdfSeam, true);
    expect(chosen.textOnlyChosen).toBe(true);
    expect(chosen.answerDisclosure).toBe(TEXT_ONLY_DISCLOSURE);
    expect(resolveComposerSubmitGate({ requiresVisual: true, seam: chosen, explicitTextOnlyChoice: true })).toEqual({
      action: 'send_text_only',
      disclosure: TEXT_ONLY_DISCLOSURE,
    });

    const photoSeam = createFallbackSeam({
      decision: unsupportedDecision,
      locator: photoLocator,
      textOnlyAvailable: false,
    });
    expect(() => requestTextOnlySend(photoSeam, true)).toThrow(/source text/i);
    expect(resolveComposerSubmitGate({ requiresVisual: true, seam: photoSeam, explicitTextOnlyChoice: true })).toEqual({
      action: 'block_show_fallback',
      disclosure: null,
    });

    render(<TextOnlyDisclosure visible />);
    expect(screen.getByRole('note', { name: TEXT_ONLY_DISCLOSURE })).toHaveTextContent(
      'Text only · Image not analysed',
    );
  });

  it('fails closed on stale/mismatched target or source locator while keeping explicit text-only intact', () => {
    const okSeam = createFallbackSeam({
      decision: supportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
    });
    expect(okSeam.unsupported).toBeNull();

    // Matching target and locator allows visual send.
    expect(
      resolveComposerSubmitGate({
        requiresVisual: true,
        seam: okSeam,
        explicitTextOnlyChoice: false,
        selectedTarget: { engine: 'claude_code', modelId: 'sonnet' },
        expectedLocator: pdfLocator,
        seamLocator: pdfLocator,
      }),
    ).toEqual({ action: 'send_with_visual', disclosure: null });

    // Same adapter, different model -> blocked (never sends visual with stale authorization).
    expect(
      resolveComposerSubmitGate({
        requiresVisual: true,
        seam: okSeam,
        explicitTextOnlyChoice: false,
        selectedTarget: { engine: 'claude_code', modelId: 'haiku' },
        expectedLocator: pdfLocator,
        seamLocator: pdfLocator,
      }),
    ).toEqual({ action: 'block_show_fallback', disclosure: null });

    // Missing model selection -> blocked.
    expect(
      resolveComposerSubmitGate({
        requiresVisual: true,
        seam: okSeam,
        explicitTextOnlyChoice: false,
        selectedTarget: { engine: 'claude_code', modelId: null },
        expectedLocator: pdfLocator,
        seamLocator: pdfLocator,
      }),
    ).toEqual({ action: 'block_show_fallback', disclosure: null });

    // Stale model + explicit text-only choice with matching locator -> explicit text-only still works.
    expect(
      resolveComposerSubmitGate({
        requiresVisual: true,
        seam: okSeam,
        explicitTextOnlyChoice: true,
        selectedTarget: { engine: 'claude_code', modelId: 'haiku' },
        expectedLocator: pdfLocator,
        seamLocator: pdfLocator,
      }),
    ).toEqual({ action: 'send_text_only', disclosure: TEXT_ONLY_DISCLOSURE });

    // Locator mismatch (different PDF page) -> blocked even with explicit text-only choice.
    const otherPage: VisualSourceLocator = { ...pdfLocator, page: 3 };
    expect(
      resolveComposerSubmitGate({
        requiresVisual: true,
        seam: okSeam,
        explicitTextOnlyChoice: true,
        selectedTarget: { engine: 'claude_code', modelId: 'sonnet' },
        expectedLocator: otherPage,
        seamLocator: pdfLocator,
      }),
    ).toEqual({ action: 'block_show_fallback', disclosure: null });

    // source_mismatch block stays blocked even after switching to a supported model.
    const mismatchSeam = createFallbackSeam({
      decision: supportedDecision,
      locator: pdfLocator,
      textOnlyAvailable: true,
      reasonCode: 'source_mismatch',
    });
    expect(mismatchSeam.unsupported?.reasonCode).toBe('source_mismatch');
    const afterSwitch = selectModelPreservingDraft(
      {
        seam: mismatchSeam,
        draftText: 'Keep my draft',
        attachmentKeys: ['att-1'],
        locator: pdfLocator,
      },
      supportedDecision,
    );
    expect(afterSwitch.autoSend).toBe(false);
    expect(afterSwitch.state.seam.unsupported?.reasonCode).toBe('source_mismatch');
  });

  it('uses only SKAZ design tokens in visualFallback.css (zero literal colors, font px, radii, un-tokenized spacing, or shadows)', () => {
    const css = readFileSync(resolve(__dirname, 'visualFallback.css'), 'utf8');
    const audit = auditCss({ 'visualFallback.css': css });
    expect(audit.colors).toEqual([]);
    expect(audit.fontSizes).toEqual([]);
    expect(audit.radii).toEqual([]);
    expect(audit.spacing).toEqual([]);
    expect(audit.shadows).toBe(0);
  });
});
