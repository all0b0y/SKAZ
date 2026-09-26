/**
 * The file a note is shared as (CODEX-NOTES-FIX-SPEC §5).
 *
 * Only the note itself: its title as the one top heading, then its text. The
 * session folder's `Note-<id>.md` carries a service tail — revision line and a
 * Sources list pointing into `Transcript.md` — that means nothing to a recipient,
 * so it is not reused. Nothing is added that the note does not already say.
 */
import { titleFromContent } from './noteTabs';

export interface ShareableNote {
  fileName: string;
  content: string;
}

const H1 = /^#[ \t]+\S/;

export function shareableNote(
  note: { title?: string; content: string },
  sessionTitle: string | null,
): ShareableNote {
  const title = note.title?.trim() || titleFromContent(note.content)
    || `Notes — ${sessionTitle?.trim() || 'untitled'}`;
  const body = note.content.replace(/\s+$/, '');
  const firstLine = body.split('\n').find((line) => line.trim()) ?? '';
  // A note that already opens with its own top heading keeps it; otherwise the
  // title becomes one, so the recipient sees what the document is called.
  const content = H1.test(firstLine) ? `${body}\n` : `# ${title}\n\n${body}${body ? '\n' : ''}`;
  return { fileName: title, content };
}
