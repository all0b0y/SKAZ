import { useEffect, useRef, useState, type DragEvent } from 'react';
import { errorText } from '../api/client';
import { Banner, Button, Icon, IconButton, Modal, Segmented, Switch, TextField } from '../ui';
import { languageName } from '../material/MaterialView';
import { useAgents, useLibrary, useServices, useSettings, useUi } from '../state/context';
import { agentOf } from '../state/agents';
import type { EngineId } from '../api/names';
import {
  fileItem, isSpeech, itemMeta, itemTitle, pasteItem, speechBlock, submitItem, wikiDefault, type AddItem, type LinkItem,
} from './addItems';
import type { KbKeys, KbSpeechSettings } from '../../api/kb/types.gen';

const SPOKEN = ['en', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'uk', 'zh', 'ja'];
const NO_LANGUAGES: readonly string[] = [];

interface WikiAuto { files: boolean; text: boolean }

/** "+ Material" (v11): drop files, paste a link or any text, choose the folder, add. */
export function AddMaterialModal() {
  const { client, bridge, library, ui } = useServices();
  const open = useUi((s) => s.addMaterialOpen);
  const setOpen = useUi((s) => s.setAddMaterialOpen);
  const folders = useLibrary((s) => s.folders);
  // The languages the user hears (Settings → Recording & speech) come first in the spoken list.
  const languages = useSettings((s) => s.speech.value?.languages) ?? NO_LANGUAGES;
  const [items, setItems] = useState<AddItem[]>([]);
  const [paste, setPaste] = useState('');
  const [folderId, setFolderId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  // 0.3.1 F1: a typed new folder name is made by Add itself — no separate Enter step to forget.
  const [newName, setNewName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [auto, setAuto] = useState<WikiAuto>({ files: true, text: false });
  const [wikiEngine, setWikiEngine] = useState<EngineId | null>(null);
  const [speechSettings, setSpeechSettings] = useState<KbSpeechSettings | null>(null);
  const [keys, setKeys] = useState<KbKeys | null>(null);
  const agents = useAgents((s) => s.agents);
  const openSettings = useUi((s) => s.openSettings);
  const [toWiki, setToWiki] = useState<boolean | null>(null);
  const [language, setLanguage] = useState('');
  const [translate, setTranslate] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [noneAdded, setNoneAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  // Defaults each time it opens: last used folder (decision 16), wiki auto-add (decision 15).
  useEffect(() => {
    if (!open) return;
    setItems([]); setPaste(''); setErrors({}); setNoneAdded(false); setToWiki(null); setDropError(null); setLanguage(''); setTranslate(false);
    setCreating(false); setNewName(''); setFolderError(null);
    // Files dropped on a folder row (0.3.1 F3) come with that folder; otherwise the last used one.
    const preset = ui.getState().addMaterialPreset;
    if (preset) {
      setFolderId(preset.folderId);
      if (preset.files.length) setItems(preset.files.map((f) => fileItem(f.path, f.name, f.size)));
      if (preset.unreadable) setDropError('Some files couldn’t be read from the drop. Choose them on the computer instead.');
    } else {
      client.call('GET /kb/recordings/defaults').then((d) => setFolderId(d.folder_id), () => setFolderId(folders.find((f) => f.system)?.id ?? ''));
    }
    client.call('GET /kb/settings/wiki').then((w) => {
      setAuto({ files: w.auto_add_files_links, text: w.auto_add_text });
      setWikiEngine(w.wiki_engine);
    }, () => undefined);
    // QA B6: what audio and video need is checked now, not after Add (one failure at a time).
    setSpeechSettings(null); setKeys(null);
    client.call('GET /kb/settings/speech').then(setSpeechSettings, () => undefined);
    client.call('GET /kb/settings/keys').then(setKeys, () => undefined);
    bridge.request<{ translation_target_language?: string }>({ method: 'GET', path: '/settings' })
      .then((r) => setTarget(r.ok ? r.data.translation_target_language ?? null : null), () => setTarget(null));
  }, [open]); // only on opening: the folder list and services are read at that moment

  // Decision 15: Settings → Wiki give the default; the switch is the user's either way and travels
  // with each add request (the backend adds the material once it is ready, or keeps it out).
  // QA B4 / B19: without a ready wiki agent the default is off, with the reason next to the switch.
  const engine = wikiEngine ?? agents?.default ?? null;
  const agentReady = engine !== null && agentOf(agents, engine)?.state === 'ready';
  const noAgent = agents !== null && !agentReady;
  const wikiOn = toWiki ?? (agentReady && wikiDefault(items, auto));
  const speech = items.some(isSpeech);
  const blocked = speech ? speechBlock(speechSettings, keys) : null;
  const openPlace = () => { if (!blocked) return; setOpen(false); openSettings(blocked.section); };
  const firstSpeech = items.find(isSpeech)?.id;

  const classify = (item: LinkItem) => {
    client.call('POST /kb/links/classify', { body: { url: item.url, probe: true } }).then(
      (info) => setItems((list) => list.map((i) => (i.id === item.id ? { ...item, info, classifying: false } : i))),
      (e: unknown) => setItems((list) => list.map((i) => (i.id === item.id ? { ...item, classifying: false, error: errorText(e) } : i))),
    );
  };
  const addPaste = () => {
    const item = pasteItem(paste);
    if (!item) return;
    setItems((list) => [...list, item]);
    setPaste('');
    if (item.type === 'link' && item.classifying) classify(item);
  };
  const addFiles = (list: Array<{ path: string; name: string; size: number | null }>) => {
    setItems((cur) => [...cur, ...list.filter((f) => !cur.some((i) => i.type === 'file' && i.path === f.path)).map((f) => fileItem(f.path, f.name, f.size))]);
  };
  const choose = async () => {
    setDropError(null);
    if (bridge.chooseMaterialFiles) { addFiles(await bridge.chooseMaterialFiles()); return; }
    if (bridge.chooseAudioFile) {
      const one = await bridge.chooseAudioFile();
      if (one) addFiles([{ path: one.path, name: one.name, size: null }]);
      return;
    }
    setDropError('Choosing files works in the SKAZ window.');
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    setDropError(null);
    const files = Array.from(e.dataTransfer.files);
    const text = e.dataTransfer.getData('text/plain');
    if (!files.length && text) { setPaste(text); return; }
    if (!bridge.droppedMediaFile) { setDropError('Dropping files works in the SKAZ window.'); return; }
    const picked = files.map((f) => ({ choice: bridge.droppedMediaFile!(f), size: f.size }))
      .filter((x): x is { choice: NonNullable<typeof x.choice>; size: number } => x.choice !== null)
      .map((x) => ({ path: x.choice.path, name: x.choice.name, size: x.size }));
    if (picked.length < files.length) setDropError('Some files couldn’t be read from the drop. Choose them on the computer instead.');
    addFiles(picked);
  };

  // A link that failed its check stays on the list with its reason; Add neither counts nor sends it (QA B23).
  const broken = (i: AddItem) => i.type === 'link' && i.error !== null;
  const sendable = items.filter((i) => !broken(i));
  const typed = creating ? newName.trim() : '';
  const taken = typed ? folders.find((f) => sameName(f.name, typed)) ?? null : null;
  const pendingNew = typed !== '' && taken === null;
  const leaveNew = () => { setCreating(false); setNewName(''); setFolderError(null); };
  const submit = async () => {
    if (!sendable.length || (creating ? !pendingNew : !folderId)) return;
    setBusy(true);
    let target = folderId;
    if (creating) {
      const made = await library.getState().createFolder(typed);
      // The backend's refusal (a name taken meanwhile, an invalid name) stays next to the field; nothing is sent.
      if (!made.ok) { setFolderError(made.error); setBusy(false); return; }
      target = made.value.id;
      setFolderId(target);
      leaveNew();
    }
    const failed: Record<string, string> = {};
    const left: AddItem[] = items.filter(broken);
    let added = 0;
    for (const item of sendable) {
      try {
        await submitItem(client, item, { folderId: target, language: language || null, translate, toWiki: wikiOn });
        added += 1;
      } catch (e) {
        failed[item.id] = errorText(e);
        left.push(item);
      }
    }
    setBusy(false);
    void library.getState().loadContent();
    setErrors(failed);
    setNoneAdded(added === 0);
    setItems(left);
    if (left.length === 0) setOpen(false);
  };

  const ready = sendable.length > 0 && items.every((i) => (i.type !== 'link' || !i.classifying) && (i.type !== 'file' || i.kind !== 'unsupported'))
    && !blocked && (creating ? pendingNew : folderId !== '');
  const spokenOptions = [...new Set([...languages, ...SPOKEN])];

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Add material" className="kb-addmat" testId="add-material-dialog" pane="add-material"
      initialFocusRef={pasteRef}>
      <div className="kb-modal__body kb-addmat__body">
        <div
          className={`kb-drop${dragging ? ' is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="drop-zone"
        >
          <Icon name="upload" size={22} />
          <b>Drop files here</b>
          <span className="kb-muted">PDF, Markdown, text, audio, video · or <button type="button" className="kb-linkbtn" onClick={() => void choose()}>choose on the computer</button></span>
        </div>
        {dropError && <p className="kb-inline-error" role="alert">{dropError}</p>}
        <div className="kb-paste">
          <Icon name="link" size={15} />
          <label className="kb-visually-hidden" htmlFor="kb-add-paste">Link or any text</label>
          <textarea id="kb-add-paste" ref={pasteRef} className="kb-paste__input" rows={1} placeholder="Paste a link or any text…" value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addPaste(); } }} />
          <Button size="sm" variant="quiet" disabled={!paste.trim()} onClick={addPaste}>Add to list</Button>
        </div>
        {items.length > 0 && (
          <ul className="kb-aq" aria-label="To add">
            {items.map((item) => (
              <li key={item.id} className="kb-aqi">
                <Icon name={item.type === 'text' ? 'text' : item.type === 'link' ? (item.info?.kind === 'video' ? 'video' : 'web') : item.kind === 'speech' ? (item.video ? 'video' : 'audio') : 'pdf'} size={15} />
                <span className="kb-aqi__main">
                  <span className="kb-aqi__title">{itemTitle(item)}</span>
                  {errors[item.id] ? (
                    <span className="kb-aqi__meta is-error" role="alert">{errors[item.id]}</span>
                  ) : (
                    <span className={`kb-aqi__meta${(item.type === 'link' && item.error) || (item.type === 'file' && item.kind === 'unsupported') ? ' is-error' : ''}`}>{itemMeta(item)}</span>
                  )}
                  {blocked && isSpeech(item) && !errors[item.id] && (
                    <span className="kb-aqi__meta is-error" data-testid="speech-block">{blocked.reason}</span>
                  )}
                </span>
                {blocked && item.id === firstSpeech && (
                  <Button size="sm" variant="outline" icon="settings" onClick={openPlace}>{blocked.action}</Button>
                )}
                {item.type === 'link' && item.info?.embedded_video && (
                  <Segmented label="Take from the article" size="sm" value={item.mode}
                    options={[{ value: 'text', label: 'Text' }, { value: 'video', label: 'Video' }, { value: 'both', label: 'Both' }]}
                    onChange={(mode) => setItems((list) => list.map((i) => (i.id === item.id ? { ...item, mode } : i)))} />
                )}
                <IconButton icon="close" size="sm" label={`Remove ${itemTitle(item)}`} onClick={() => setItems((list) => list.filter((i) => i.id !== item.id))} />
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <div className="kb-aopt">
            <div className="kb-arow">
              <span className="kb-arow__label" id="kb-add-folder">Folder</span>
              {creating ? (
                <span className="kb-afolder">
                  <TextField label="New folder name" hideLabel placeholder="Folder name" leading="folder" maxLength={120}
                    autoFocus value={newName} error={folderError} disabled={busy}
                    onChange={(e) => { setNewName(e.target.value); setFolderError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); if (ready) void submit(); }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leaveNew(); }
                    }} />
                  <IconButton icon="close" size="sm" label="Back to the folder list" onClick={leaveNew} />
                </span>
              ) : (
                <span className="kb-select">
                  <select aria-labelledby="kb-add-folder" value={folderId}
                    onChange={(e) => { if (e.target.value === '__new') { setCreating(true); setNewName(''); setFolderError(null); } else setFolderId(e.target.value); }}>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    <option value="__new">New folder…</option>
                  </select>
                  <Icon name="chevronDown" size={12} className="kb-select__chev" />
                </span>
              )}
            </div>
            {creating && taken && (
              <p className="kb-arow__hint" data-testid="add-folder-taken">
                <span className="kb-inline-error">A folder with this name exists.</span>{' '}
                <button type="button" className="kb-linkbtn" onClick={() => { setFolderId(taken.id); leaveNew(); }}>{`Add to «${taken.name}»`}</button>
              </p>
            )}
            {creating && pendingNew && !folderError && (
              <p className="kb-arow__hint kb-muted">New folder — made when you press Add.</p>
            )}
            <div className="kb-arow">
              <span className="kb-arow__label">Wiki</span>
              <Switch label="Add to wiki after processing" checked={wikiOn} onChange={setToWiki} />
              <span>Add to wiki after processing</span>
            </div>
            {noAgent && (
              <p className="kb-arow__hint kb-muted" data-testid="add-wiki-no-agent">
                Connect an agent in Settings → Accounts &amp; keys to add materials to the wiki.{' '}
                <button type="button" className="kb-linkbtn" onClick={() => { setOpen(false); openSettings('conn'); }}>Open Accounts &amp; keys</button>
              </p>
            )}
            {speech && (
              <div className="kb-arow">
                <span className="kb-arow__label">Audio and video</span>
                <span className="kb-select">
                  <select aria-label="Spoken language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="">Language: detect</option>
                    {spokenOptions.map((l) => <option key={l} value={l}>{`Language: ${languageName(l)}`}</option>)}
                  </select>
                  <Icon name="chevronDown" size={12} className="kb-select__chev" />
                </span>
                <Switch label="Translate" checked={translate} onChange={setTranslate} />
                <span>{target ? `Translate into ${languageName(target)}` : 'Translate'}</span>
              </div>
            )}
          </div>
        )}
        {Object.keys(errors).length > 0 && (noneAdded
          ? <Banner tone="error" title="None of these were added.">Fix or remove them and try again.</Banner>
          : <Banner tone="error" title="Some materials weren’t added.">The others were. Fix or remove these and try again.</Banner>
        )}
      </div>
      <div className="kb-modal__foot">
        <span className="kb-muted">{sendable.length ? `${sendable.length} ${sendable.length === 1 ? 'material' : 'materials'}` : ''}</span>
        <span className="kb-head__spacer" />
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="fill" busy={busy} disabled={!ready} onClick={() => void submit()}>
          {creating && pendingNew ? `Create «${typed}» and add ${sendable.length}` : sendable.length > 1 ? `Add ${sendable.length}` : 'Add'}
        </Button>
      </div>
    </Modal>
  );
}

/** Folder names compare like the backend does: Unicode-normalised, case-insensitive. */
function sameName(a: string, b: string): boolean {
  const key = (s: string) => s.normalize('NFC').toLocaleLowerCase();
  return key(a.trim()) === key(b.trim());
}
