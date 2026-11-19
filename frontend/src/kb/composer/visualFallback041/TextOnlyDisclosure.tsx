import { Icon } from '../../ui';
import { TEXT_ONLY_DISCLOSURE } from './types';
import './visualFallback.css';

/** Quiet disclosure shown above an assistant reply sent explicitly without image analysis. */
export function TextOnlyDisclosure({ visible = true }: { visible?: boolean }) {
  if (!visible) return null;
  return (
    <p className="kb-visual-disclosure" role="note" aria-label={TEXT_ONLY_DISCLOSURE}>
      <Icon name="text" size={14} className="kb-visual-disclosure__icon" />
      <span>{TEXT_ONLY_DISCLOSURE}</span>
    </p>
  );
}
