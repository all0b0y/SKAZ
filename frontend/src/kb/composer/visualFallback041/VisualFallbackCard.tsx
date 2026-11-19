import type { Ref } from 'react';
import { Button, Icon } from '../../ui';
import type { VisualFallbackSeam } from './types';
import './visualFallback.css';

export interface VisualFallbackCardProps {
  id?: string;
  seam: VisualFallbackSeam;
  /** Opens or focuses the existing model picker without submitting the draft. */
  onChooseModel: () => void;
  /** Explicit user action to send text-only when usable source text exists. */
  onContinueTextOnly: () => void;
  /** Ref for focusing the primary action when a blocked submit is attempted. */
  chooseModelRef?: Ref<HTMLButtonElement>;
  busy?: boolean;
}

/**
 * UI-B non-sending fallback card rendered above the composer, outside message history
 * (`.dev/task-context/visual-fallback.html?variant=b`). Visible only for the affected draft.
 */
export function VisualFallbackCard({
  id,
  seam,
  onChooseModel,
  onContinueTextOnly,
  chooseModelRef,
  busy = false,
}: VisualFallbackCardProps) {
  const unsupported = seam.unsupported;
  if (!unsupported) return null;

  return (
    <section
      id={id}
      className="kb-visual-fallback"
      role="group"
      aria-label="Image unavailable"
      data-testid="visual-fallback-card"
    >
      <div className="kb-visual-fallback__copy">
        <Icon name="warning" size={16} className="kb-visual-fallback__icon" />
        <div className="kb-visual-fallback__text">
          <strong className="kb-visual-fallback__title">{unsupported.title}</strong>
          <p className="kb-visual-fallback__detail">{unsupported.detail}</p>
        </div>
      </div>
      <div className="kb-visual-fallback__actions">
        <Button
          ref={chooseModelRef}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onChooseModel}
        >
          Choose a model
        </Button>
        {seam.textOnlyAvailable && (
          <Button
            variant="quiet"
            size="sm"
            className="kb-visual-fallback__secondary"
            disabled={busy}
            onClick={onContinueTextOnly}
          >
            Continue with text only
          </Button>
        )}
      </div>
    </section>
  );
}
