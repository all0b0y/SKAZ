/**
 * Where a selection made in the rendered note sits in the note's Markdown source.
 *
 * The editor shows formatted Markdown at rest, so a selection lives in rendered
 * text while the passage to rewrite has to be named as offsets into the stored
 * source. The two differ wherever markup was consumed: selecting `слово` inside
 * `**слово**` yields six characters on screen and ten in the file.
 *
 * The block the selection sits in is resolved first (its source offsets are
 * attached during rendering), and the selected text is looked for inside that
 * block's source. Nothing is widened to fit: a selection that cannot be located
 * character-for-character reports `null`, and the caller offers no rewrite rather
 * than replacing more text than the user pointed at.
 */

export interface SourceSpan {
  start: number;
  end: number;
}

/** The source range of one rendered block, as attached by the offsets plugin. */
export interface BlockRange {
  start: number;
  end: number;
}

export const SOURCE_START_ATTR = 'data-md-start';
export const SOURCE_END_ATTR = 'data-md-end';

/**
 * Locate `selected` inside `source`, preferring the block the user selected in.
 *
 * `block` narrows the search so that a phrase repeated across the note resolves
 * to the copy that was actually selected. Without it — or when the block's source
 * does not contain the text verbatim, which is what markup does — the whole
 * document is searched, and an ambiguous match is refused rather than guessed.
 */
export function resolveSelectionSpan(
  source: string, selected: string, block?: BlockRange | null,
): SourceSpan | null {
  const needle = selected.trim();
  if (!needle) return null;

  if (block && block.start >= 0 && block.end <= source.length && block.start < block.end) {
    const within = locateUnique(source.slice(block.start, block.end), needle);
    if (within) return { start: block.start + within.start, end: block.start + within.end };
  }
  return locateUnique(source, needle);
}

/** The one occurrence of `needle`, or null when there is none or several. */
function locateUnique(haystack: string, needle: string): SourceSpan | null {
  const first = haystack.indexOf(needle);
  if (first < 0) return null;
  // A phrase that appears twice cannot be resolved from its text alone, and
  // rewriting the wrong copy is worse than offering nothing.
  if (haystack.indexOf(needle, first + 1) >= 0) return null;
  return { start: first, end: first + needle.length };
}

/**
 * The source range of the rendered block containing `node`, if it carries one.
 *
 * Only blocks rendered from the note's own Markdown have the attributes, so text
 * from anywhere else in the window resolves to nothing instead of to a range in
 * a document it never came from.
 */
export function blockRangeOf(node: Node | null, root: Element | null): BlockRange | null {
  let element: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (element && (!root || root.contains(element))) {
    const start = element.getAttribute(SOURCE_START_ATTR);
    const end = element.getAttribute(SOURCE_END_ATTR);
    if (start !== null && end !== null) {
      const from = Number(start);
      const to = Number(end);
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { start: from, end: to };
    }
    element = element.parentElement;
  }
  return null;
}
