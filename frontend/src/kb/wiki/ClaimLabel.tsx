import { Icon } from '../ui';
import { CLAIM_ICON, CLAIM_LABEL, EDITED_LABEL, type ClaimKind } from './blocks';

/** Statement-type label: icon + caption + its own pill style (decision 20). Also the wiki legend's sample. */
export function ClaimLabel({ kind, edited = false }: { kind: ClaimKind; edited?: boolean }) {
  return (
    <span className={`kb-claim kb-claim--${edited ? 'edited' : kind}`} data-claim={edited ? 'edited' : kind}>
      <Icon name={edited ? 'pencil' : CLAIM_ICON[kind]} size={12} />
      {edited ? EDITED_LABEL : CLAIM_LABEL[kind]}
    </span>
  );
}
