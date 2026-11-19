import type { ReactNode } from 'react';
import { MarkdownView } from '../ui/markdown/Markdown';
import { HeadingMark } from '../document/headingAccents041/headingAccents';

/**
 * Markdown of a chat answer whose inline slots (`slots[i]`: source and page chips) stand inside the
 * text where they were in the answer. `pieces` alternate text and slot indexes. The renderer is the
 * app's one Markdown renderer (kb/ui/markdown), shared with wiki pages and notes.
 *
 * G1 (SKAZ 0.4.1): the answer's main headings (`#`) open with the accepted decorative `//` — ink,
 * never text — so the heading's accessible name, quotes, the find walk and copies keep exactly its
 * own words. Only this reply host opts in: deeper headings and the other Markdown hosts (wiki
 * blocks, wiki files) stay plain.
 */
export function InlineMarkdown({ pieces, slot }: {
  pieces: ReadonlyArray<string | number>;
  slot: (index: number, key: string) => ReactNode;
}) {
  return <MarkdownView className="kb-md" pieces={pieces} slot={slot} linkClassName="kb-md__link"
    mainHeadingMark={<HeadingMark kind="slashes" />} />;
}
