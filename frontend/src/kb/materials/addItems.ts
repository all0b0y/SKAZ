// What "+ Material" sends, decided without the UI: file type by extension, link vs text, and the
// route per item (API-B2 §4; package-1 routes for files, text and speech imports).

import type { KbLinkInfo, KbMaterialSummary } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';

const SPEECH_EXT = new Set(['aac', 'aiff', 'amr', 'asf', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'opus']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm']);

export type FileKind = 'speech' | 'document';

export interface FileItem { id: string; type: 'file'; path: string; name: string; size: number | null; kind: FileKind; video: boolean }
export interface LinkItem {
  id: string; type: 'link'; url: string; info: KbLinkInfo | null; classifying: boolean; error: string | null;
  /** Article with an embedded video: what to take (text / video / both). */
  mode: 'text' | 'video' | 'both';
}
export interface TextItem { id: string; type: 'text'; text: string }
export type AddItem = FileItem | LinkItem | TextItem;

let seq = 0;
const nextId = () => `add-${++seq}`;

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

export function fileItem(path: string, name: string, size: number | null): FileItem {
  const ext = extensionOf(name);
  return { id: nextId(), type: 'file', path, name, size, kind: SPEECH_EXT.has(ext) ? 'speech' : 'document', video: VIDEO_EXT.has(ext) };
}

/** One pasted line: a web address becomes a link, anything else is text (no length limit). */
export function pasteItem(raw: string): LinkItem | TextItem | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\/\S+$/i.test(text)) {
    return { id: nextId(), type: 'link', url: text, info: null, classifying: true, error: null, mode: 'text' };
  }
  return { id: nextId(), type: 'text', text };
}

/** Speech that needs a spoken language and may be translated: audio/video files and video links. */
export function isSpeech(item: AddItem): boolean {
  if (item.type === 'file') return item.kind === 'speech';
  if (item.type === 'link') return item.info?.kind === 'video';
  return false;
}

/** Decision 15: files and links go to the wiki by default, pasted text does not. */
export function wikiDefault(items: readonly AddItem[], settings: { files: boolean; text: boolean }): boolean {
  if (items.length === 0) return settings.files;
  return items.some((i) => i.type !== 'text') ? settings.files : settings.text;
}

export function itemTitle(item: AddItem): string {
  if (item.type === 'file') return item.name;
  if (item.type === 'link') return item.info?.title ?? item.url;
  const first = item.text.split('\n')[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

export function itemMeta(item: AddItem): string {
  if (item.type === 'file') {
    const kind = item.kind === 'speech' ? (item.video ? 'Video' : 'Audio') : extensionOf(item.name).toUpperCase() || 'File';
    return item.size !== null ? `${kind} · ${formatBytes(item.size)}` : kind;
  }
  if (item.type === 'link') {
    if (item.classifying) return 'Checking the link…';
    if (item.error) return item.error;
    const info = item.info;
    if (!info) return 'Link';
    const label = info.kind === 'video' ? 'Video' : info.kind === 'pdf' ? 'PDF' : info.kind === 'site' ? 'Article'
      : info.kind === 'audio_file' ? 'Audio file' : 'Video file';
    const duration = info.duration_ms ? ` · ${formatDuration(info.duration_ms)}` : '';
    return `${info.label || info.domain} · ${label}${duration}`;
  }
  return `Text · ${item.text.length.toLocaleString('en-GB')} characters`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export interface AddOptions {
  folderId: string;
  /** Spoken language of audio/video; null = detect. */
  language: string | null;
  translate: boolean;
  /** Decision 15: the user's "Add to wiki" switch, sent with the request; the backend honours it. */
  toWiki: boolean;
}

export interface Added {
  materialId: string;
  /** Ready now (files, text) or still processing (imports, links). */
  ready: boolean;
}

/** Send one item; returns the materials it created (a link in mode "both" makes two). */
export async function submitItem(client: KbClient, item: AddItem, o: AddOptions): Promise<Added[]> {
  const fromSummary = (m: KbMaterialSummary): Added => ({ materialId: m.id, ready: m.status === 'ready' });
  if (item.type === 'file') {
    if (item.kind === 'speech') {
      const view = await client.call('POST /kb/imports', { body: { path: item.path, folder_id: o.folderId, translate: o.translate, language: o.language, to_wiki: o.toWiki } });
      return [{ materialId: view.material_id, ready: view.status === 'ready' }];
    }
    const added = await client.call('POST /kb/materials/file', { body: { path: item.path, folder_id: o.folderId, to_wiki: o.toWiki } });
    return [fromSummary(added.material)];
  }
  if (item.type === 'text') {
    const added = await client.call('POST /kb/materials/text', { body: { text: item.text, folder_id: o.folderId, to_wiki: o.toWiki } });
    return [fromSummary(added.material)];
  }
  // A plain video link goes to the speech import (spoken language + translation apply);
  // an article with a video asks text/video/both and goes to /kb/materials/link (§4).
  if (item.info?.kind === 'video') {
    const view = await client.call('POST /kb/imports', { body: { url: item.url, folder_id: o.folderId, translate: o.translate, language: o.language, to_wiki: o.toWiki } });
    return [{ materialId: view.material_id, ready: view.status === 'ready' }];
  }
  const added = await client.call('POST /kb/materials/link', {
    body: { url: item.url, folder_id: o.folderId, to_wiki: o.toWiki, ...(item.info?.embedded_video ? { mode: item.mode } : {}) },
  });
  return [fromSummary(added.material)];
}
