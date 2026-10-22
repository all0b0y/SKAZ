import type { ReactNode } from 'react';
import { MarkdownView } from '../ui/markdown/Markdown';

/**
 * Markdown of a chat answer whose inline slots (`slots[i]`: source and page chips) stand inside the
 * text where they were in the answer. `pieces` alternate text and slot indexes. The renderer is the
 * app's one Markdown renderer (kb/ui/markdown), shared with wiki pages and notes.
 */
export function InlineMarkdown({ pieces, slot }: {
  pieces: ReadonlyArray<string | number>;
  slot: (index: number, key: string) => ReactNode;
}) {
  return <MarkdownView className="kb-md" pieces={pieces} slot={slot} linkClassName="kb-md__link" />;
}
