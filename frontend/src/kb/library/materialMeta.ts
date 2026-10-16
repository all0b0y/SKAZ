import type { KbMaterialSummary } from '../../api/kb/types.gen';
import type { IconName } from '../ui';

type Kind = KbMaterialSummary['kind'];

/** Lucide icon per material type (decision 40: no brand logos). */
export const KIND_ICON: Record<Kind, IconName> = {
  recording: 'mic',
  audio: 'audio',
  video: 'video',
  video_link: 'video',
  pdf: 'pdf',
  book: 'pdf',
  web: 'link',
  text: 'text',
};

export const KIND_LABEL: Record<Kind, string> = {
  recording: 'Recording',
  audio: 'Audio',
  video: 'Video',
  video_link: 'Video link',
  pdf: 'PDF',
  book: 'Book',
  web: 'Article',
  text: 'Text',
};

/** 492000 → "08:12"; past an hour → "1:08:12". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Folder colour slot 1..4 by the folder's place among user folders (Inbox has none). */
export function folderTone(index: number): string {
  return `var(--kb-folder-${(index % 4) + 1})`;
}
