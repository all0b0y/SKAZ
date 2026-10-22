import type { KbSavedAnalysis } from '../../api/kb/types.gen';

/** The status line after «Save to wiki»: the page, then what was left out and why (decision 9). */
export const savedText = (saved: KbSavedAnalysis): string =>
  `Saved to the wiki as “${saved.title}”.${saved.warning ? ` ${saved.warning}` : ''}`;
