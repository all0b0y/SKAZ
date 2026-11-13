// Material read-mark vocabulary remains shared while the retired finding UI is removed.
import type { KbReadMark } from '../../../api/kb/types.gen';

export type ReadMarkValue = NonNullable<KbReadMark['value']>;
export const READ_MARKS: readonly ReadMarkValue[] = ['useful_method', 'changed_my_view', 'already_knew', 'not_for_me'];
export const READ_MARK_TEXT: Record<ReadMarkValue, string> = {
  useful_method: 'Useful method',
  changed_my_view: 'Changed my view',
  already_knew: 'Already knew this',
  not_for_me: 'Not for me',
};
