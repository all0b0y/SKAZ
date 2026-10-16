import type { MouseEvent } from 'react';
import { Icon, type IconName } from './Icon';

export type ChipKind = 'recording' | 'document' | 'wiki' | 'link' | 'video';

const KIND_ICON: Record<ChipKind, IconName> = {
  recording: 'play',
  document: 'pdf',
  wiki: 'concept',
  link: 'link',
  video: 'video',
};

const KIND_LABEL: Record<ChipKind, string> = {
  recording: 'Recording',
  document: 'Document',
  wiki: 'Wiki page',
  link: 'Link',
  video: 'Video',
};

export interface ChipProps {
  kind: ChipKind;
  label: string;
  /** Muted tail: time (08:12) for recordings, page (p. 31) for documents. */
  meta?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A more exact type icon (a folder overview among wiki pages); the kind's icon otherwise. */
  icon?: IconName;
}

/**
 * Source chip: a rounded pill with a Lucide type icon, the name and a muted time/page.
 * The palette is monochrome (accent = text), so the pill shape is what marks a reference.
 */
export function Chip({ kind, label, meta, onClick, icon }: ChipProps) {
  const name = `${KIND_LABEL[kind]}: ${label}${meta ? `, ${meta}` : ''}`;
  const body = (
    <>
      <Icon name={icon ?? KIND_ICON[kind]} size={12} />
      {label && <span className="kb-chip__label">{label}</span>}
      {meta && <span className="kb-chip__meta">{meta}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="kb-chip" data-kind={kind} aria-label={name} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <span className="kb-chip" data-kind={kind} role="note" aria-label={name}>{body}</span>;
}
