/*
 * B1 — SKAZ 0.4.1, decision 04 §4: the ↓ return-to-latest button over the composer's right edge.
 * It appears only once the user has left the bottom, and it jumps to the newest message without
 * touching what streaming is writing (the explicit «return to last», not a forced pull).
 */

export interface ReturnToLatestProps {
  /** From the anchor state: true once the view is farther than RETURN_VISIBLE_SLACK_PX from the bottom. */
  visible: boolean;
  onReturn: () => void;
}

export function ReturnToLatest({ visible, onReturn }: ReturnToLatestProps) {
  return (
    <button type="button" className="kb-return-bottom"
      aria-label="Return to the latest message"
      title="Return to the latest message"
      hidden={!visible}
      onClick={onReturn}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}
