import { useEffect, useId, useRef, useState } from 'react';
import type { MaterialFileChoice } from '../../api/bridge';
import type { KbRef, MaterialKind } from '../api/b2';
import { errorText, type KbClient } from '../api/client';
import { Button, Icon, IconButton, Menu } from '../ui';
import { Popover } from '../ui/Popover';
import { useLibrary, useServices } from '../state/context';

/**
 * "+" in the message field (v3, decision 15): a file, a link, pasted text or one of my materials.
 * Everything new is saved to Materials right away (Inbox when no folder is chosen — decision 16)
 * through the existing material routes; "In wiki" is on by default for files and links, off for
 * pasted text, and can be switched until the message is sent.
 */
export interface Attachment {
  key: string;
  name: string;
  source: 'file' | 'link' | 'text' | 'existing';
  state: 'adding' | 'ready' | 'failed';
  materialId: string | null;
  error: string | null;
  inWiki: boolean;
}

const SPEECH_EXT = new Set(['aac', 'aiff', 'amr', 'asf', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'webm', 'mkv', 'mov', 'avi', 'm4v']);

export function isSpeechFile(name: string): boolean {
  return SPEECH_EXT.has(/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '');
}

/** Create the material for one attachment; resolves with its id. */
export async function addMaterial(client: KbClient, source: 'file' | 'link' | 'text', value: string, folderId: string): Promise<string> {
  if (source === 'file') {
    if (isSpeechFile(value)) {
      const res = await client.call('POST /kb/imports', { body: { path: value, folder_id: folderId } });
      return res.material_id;
    }
    const res = await client.call('POST /kb/materials/file', { body: { path: value, folder_id: folderId } });
    return res.material.id;
  }
  if (source === 'link') {
    const res = await client.call('POST /kb/materials/link', { body: { url: value, folder_id: folderId } });
    return res.material.id;
  }
  const res = await client.call('POST /kb/materials/text', { body: { text: value, folder_id: folderId } });
  return res.material.id;
}

let seq = 0;
export const attachmentKey = () => `att-${++seq}`;

type Mode = null | 'link' | 'text' | 'materials';

export function AttachButton({ onAdd, disabled }: {
  onAdd: (items: Array<{ source: Attachment['source']; name: string; value: string; materialId?: string }>) => void;
  disabled: boolean;
}) {
  const { bridge } = useServices();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);

  const chooseFiles = async () => {
    const files: MaterialFileChoice[] = (await bridge.chooseMaterialFiles?.()) ?? [];
    if (files.length) onAdd(files.map((f) => ({ source: 'file' as const, name: f.name, value: f.path })));
  };

  return (
    <>
      <IconButton ref={anchor} icon="plus" label="Add a file, link or text" aria-haspopup="menu" aria-expanded={menu || mode !== null}
        disabled={disabled} onClick={() => { setError(null); setMenu((v) => !v); }} tooltipPlacement="top-start" />
      <Menu open={menu} onClose={() => setMenu(false)} anchorRef={anchor} label="Add to the question" placement="top-start" items={[
        { id: 'file', label: 'File…', icon: 'upload', disabled: !bridge.chooseMaterialFiles, note: bridge.chooseMaterialFiles ? undefined : 'not available here', onSelect: () => void chooseFiles() },
        { id: 'link', label: 'Link…', icon: 'link', onSelect: () => setMode('link') },
        { id: 'text', label: 'Paste text…', icon: 'text', onSelect: () => setMode('text') },
        { id: 'materials', label: 'From my materials…', icon: 'materials', onSelect: () => setMode('materials') },
      ]} />
      <Popover open={mode !== null} onClose={() => setMode(null)} anchorRef={anchor} placement="top-start" width={340}
        label={mode === 'link' ? 'Add a link' : mode === 'text' ? 'Paste text' : 'From my materials'} className="kb-attachpop">
        {mode === 'link' && <LinkForm onDone={(url) => { setMode(null); onAdd([{ source: 'link', name: url, value: url }]); }} />}
        {mode === 'text' && <TextForm onDone={(text) => { setMode(null); onAdd([{ source: 'text', name: firstLine(text), value: text }]); }} />}
        {mode === 'materials' && <MaterialPicker onDone={(ref) => { setMode(null); onAdd([{ source: 'existing', name: ref.title, value: ref.id, materialId: ref.id }]); }} />}
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
      </Popover>
    </>
  );
}

const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || 'Pasted text';
};

function LinkForm({ onDone }: { onDone: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = () => {
    const value = url.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
      setError('Enter a web address that starts with http:// or https://');
      return;
    }
    onDone(value);
  };
  return (
    <form className="kb-attachform" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label htmlFor={id} className="kb-attachform__label">Link to an article or a video</label>
      <input id={id} className="kb-attachform__input" type="url" placeholder="https://" value={url}
        onChange={(e) => { setUrl(e.target.value); setError(null); }} aria-invalid={error ? true : undefined} />
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      <div className="kb-attachform__foot"><Button size="sm" variant="fill" type="submit" disabled={!url.trim()}>Add</Button></div>
    </form>
  );
}

function TextForm({ onDone }: { onDone: (text: string) => void }) {
  const [text, setText] = useState('');
  const id = useId();
  return (
    <form className="kb-attachform" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onDone(text); }}>
      <label htmlFor={id} className="kb-attachform__label">Any text — it is saved to Materials</label>
      <textarea id={id} className="kb-attachform__input kb-attachform__area" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="kb-attachform__foot"><Button size="sm" variant="fill" type="submit" disabled={!text.trim()}>Add</Button></div>
    </form>
  );
}

function MaterialPicker({ onDone }: { onDone: (ref: KbRef) => void }) {
  const { client } = useServices();
  const materials = useLibrary((s) => s.materials);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<KbRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    if (!q.trim()) { setFound(null); return undefined; }
    let live = true;
    const t = window.setTimeout(() => {
      client.call('GET /kb/mentions', { query: { q: q.trim(), limit: 8 } }).then(
        (res) => { if (live) { setFound(res.materials); setError(null); } },
        (e: unknown) => { if (live) setError(errorText(e)); },
      );
    }, 120);
    return () => { live = false; window.clearTimeout(t); };
  }, [client, q]);
  const list: KbRef[] = found ?? materials.slice(0, 8).map((m) => ({ type: 'material', id: m.id, title: m.title }));
  return (
    <div className="kb-attachform">
      <label htmlFor={id} className="kb-visually-hidden">Find a material</label>
      <div className="kb-attachform__search">
        <Icon name="search" size={14} />
        <input id={id} className="kb-attachform__input kb-attachform__input--bare" placeholder="Find a material" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      <ul className="kb-attachform__list" aria-label="Materials">
        {list.length === 0 && <li className="kb-muted kb-attachform__empty">{q ? 'Nothing found.' : 'No materials yet.'}</li>}
        {list.map((m) => (
          <li key={m.id}>
            <button type="button" className="kb-row" onClick={() => onDone(m)}>
              <Icon name="pdf" size={14} className="kb-row__icon" />
              <span className="kb-row__text">{m.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AttachmentChips({ items, autoWiki, onToggleWiki, onRemove }: {
  items: Attachment[];
  /** Settings → Wiki adds this kind automatically: the switch can't turn it off here. */
  autoWiki: (a: Attachment) => boolean;
  onToggleWiki: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="kb-attachments" aria-label="Attachments">
      {items.map((a) => {
        const forced = a.source !== 'existing' && autoWiki(a);
        return (
          <li key={a.key} className={`kb-attachment is-${a.state}`}>
            <Icon name={a.source === 'link' ? 'link' : a.source === 'text' ? 'text' : 'pdf'} size={13} />
            <span className="kb-attachment__name" title={a.name}>{a.name}</span>
            {a.state === 'adding' && <span className="kb-spinner kb-spinner--inline" role="status" aria-label="Saving to Materials" />}
            {a.state === 'failed' && <span className="kb-attachment__err" role="alert" title={a.error ?? ''}><Icon name="error" size={13} />{a.error}</span>}
            {a.source !== 'existing' && a.state !== 'failed' && (
              <label className="kb-attachment__wiki" title={forced ? 'Settings → Wiki adds new files and links automatically' : undefined}>
                <input type="checkbox" checked={forced || a.inWiki} disabled={forced} onChange={() => onToggleWiki(a.key)} />
                In wiki
              </label>
            )}
            <button type="button" className="kb-attachment__x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.key)}>
              <Icon name="close" size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type { MaterialKind };
