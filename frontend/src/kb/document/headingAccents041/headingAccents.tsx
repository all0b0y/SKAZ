import type { ReactNode } from 'react';
import type { WikiKind } from '../../state/prefs';
import './headingAccents.css';

/**
 * G1 (SKAZ 0.4.1) — decorative heading accents: `09-HEADING-ACCENTS.md` and the approved
 * `heading-accents-selected.html`. One `@` marks the open Material/Wiki document title, `//` the
 * main headings of a chat answer, one star the Notes title and the main Wiki/Notes sections.
 * Menus, small headings, functional icons and copied/exported text stay untouched.
 *
 * The marker is ink, never text: every kind is a drawn stroke picture (no text node in the DOM),
 * so the accessible name of the heading, quotes (`ui/Selection.tsx` reads the selection), the
 * chat picker's text walk (`chat/select/items.ts`), clipboard copies and the Markdown export
 * (written from the source, never the DOM) keep exactly the heading's own words. The span is
 * decoration: `aria-hidden`, no focus. Colour is the existing Appearance accent token — no new
 * setting, no fx accent.
 */

/** The three signs of the accepted layout. */
export type HeadingMarkKind = 'at' | 'slashes' | 'star';

/** `title` is the larger mark of an open document's name; `inline` fits sections and chat. */
export type HeadingMarkSize = 'inline' | 'title';

/** The class a host heading adds to lay its mark and title out on one baseline. */
export const headingLineClass = 'kb-ham-line';

/** Which sign an open document's title takes: `@` for a material and any wiki page, a star for Notes. */
export function documentTitleMark(target: 'material' | WikiKind): HeadingMarkKind {
  return target === 'note' ? 'star' : 'at';
}

/* Stroke pictures, 16-box, drawn 1.5-wide with round ends like the app's icons (ICON_STROKE).
   The star is the six-stroke asterisk of the approved mock; the other two are the same signs
   drawn, not typed. */
const GLYPH: Record<HeadingMarkKind, ReactNode> = {
  star: <path d="M8 2v12M3 5l10 6M3 11l10-6" />,
  slashes: <path d="M6.5 2.5 4 13.5M12.5 2.5 10 13.5" />,
  at: (<>
    <circle cx="8" cy="8" r="2.67" />
    <path d="M10.67 5.33v3.33a2 2 0 0 0 4 0v-0.67a6.67 6.67 0 1 0-2.67 5.33" />
  </>),
};

/**
 * The decorative mark of a heading. Contributes nothing but ink: hidden from the a11y tree, no
 * text to select or copy, no focus. Compose it inside the heading, before the title text, and add
 * {@link headingLineClass} to the heading for the one-line baseline layout — or drop it into an
 * existing row (a section head's toggle): it is `flex: none` and centres like the chevron.
 */
export function HeadingMark({ kind, size = 'inline', className }: {
  kind: HeadingMarkKind;
  size?: HeadingMarkSize;
  className?: string;
}) {
  const classes = ['kb-ham', size === 'title' ? 'kb-ham--title' : '', className].filter(Boolean).join(' ');
  return (
    <span className={classes} data-ham={kind} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round" focusable="false">{GLYPH[kind]}</svg>
    </span>
  );
}
