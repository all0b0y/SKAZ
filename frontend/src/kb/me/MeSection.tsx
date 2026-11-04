import { useEffect, useId, useState } from 'react';
import { Button, Icon, Switch, TextField } from '../ui';
import { shortTime } from '../ui/time';
import { useServices, useSettings } from '../state/context';
import { errorText } from '../api/client';
import {
  createMeSkill, deleteMeSkill, meSkillVersions, readMeSkill, restoreMeVersion, updateMeSkill,
} from './api';
import type { KbMeSkill, KbMeSkillDetail, KbMeVersion } from '../../api/kb/types.gen';

/** Decision 5: the honest line about where «Я» lives and who can read it. */
export const ME_STORAGE_NOTE = 'Stored encrypted on this Mac. Other apps can’t read it through SKAZ; a program that targets SKAZ under your macOS user could.';

const n = (x: number) => x.toLocaleString('en-US');

const SOURCE: Record<KbMeVersion['source'], string> = { agent: 'By the agent', user: 'By you', restore: 'Restored' };

function Failed({ error, retry }: { error: string; retry: () => void }) {
  return (
    <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
      Couldn’t read: {error}
      <Button size="sm" variant="quiet" icon="retry" onClick={retry}>Try again</Button>
    </span>
  );
}

const Reading = () => <span className="kb-muted" role="status">Reading…</span>;

/** Replace one skill of the list on screen with what the backend answered. */
function usePutSkill() {
  const { settings } = useServices();
  return (d: KbMeSkillDetail) => settings.setState((s) => {
    if (!s.me.value) return {};
    const { text: _t, ...skill } = d;
    void _t;
    const known = s.me.value.skills.some((k) => k.id === d.id);
    const skills = known ? s.me.value.skills.map((k) => (k.id === d.id ? skill : k)) : [...s.me.value.skills, skill];
    return { me: { value: { ...s.me.value, skills }, error: null } };
  });
}

/** Settings → Me → "Use Me in chats": the master switch (off = nothing of «Я» reaches any agent). */
export function MeSwitchRow({ label }: { label: string }) {
  const { settings } = useServices();
  const me = useSettings((s) => s.me);
  const [error, setError] = useState<string | null>(null);
  if (!me.value) return me.error ? <Failed error={me.error} retry={() => void settings.getState().loadMe()} /> : <Reading />;
  return (
    <>
      <Switch label={label} checked={me.value.enabled} onChange={async (v) => {
        const res = await settings.getState().setMeEnabled(v);
        setError(res.ok ? null : res.error);
      }} />
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </>
  );
}

/** How full a limited skill is: «640 / 1,400». */
function FillBar({ skill }: { skill: KbMeSkill & { limit: number } }) {
  const share = Math.min(1, skill.chars / skill.limit);
  const tone = skill.chars >= skill.limit ? 'full' : share >= 0.85 ? 'near' : 'ok';
  return (
    <div className="kb-me__fill" data-tone={tone}>
      <div className="kb-me__bar" role="meter" aria-label={`${skill.title}: filled`} aria-valuemin={0} aria-valuemax={skill.limit}
        aria-valuenow={Math.min(skill.chars, skill.limit)} aria-valuetext={`${n(skill.chars)} of ${n(skill.limit)} characters`}>
        <i style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <span className="kb-me__count">{n(skill.chars)} / {n(skill.limit)}</span>
    </div>
  );
}

function SkillRow({ skill, onOpen }: { skill: KbMeSkill; onOpen: () => void }) {
  const { client } = useServices();
  const putSkill = usePutSkill();
  const labelId = useId();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="kb-srow kb-me__skill" data-skill={skill.id} role="group" aria-labelledby={labelId}>
      <div className="kb-srow__text">
        <div id={labelId} className="kb-srow__label">{skill.title}</div>
        <div className="kb-srow__hint">
          {skill.builtin && <span className="kb-me__tag">Built-in</span>}
          {skill.always_on && <span className="kb-me__tag">Always in the prompt</span>}
          {skill.description}
        </div>
        {skill.limit !== null && <FillBar skill={{ ...skill, limit: skill.limit }} />}
        {skill.limit === null && skill.version === 0 && <div className="kb-srow__hint">Empty</div>}
        {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
      </div>
      <div className="kb-srow__control">
        <Button size="sm" onClick={onOpen} aria-label={`Open ${skill.title}`}>Open</Button>
        <Switch label={skill.title} checked={skill.enabled} onChange={async (enabled) => {
          try {
            putSkill(await updateMeSkill(client, skill.id, { enabled }));
            setError(null);
          } catch (e) {
            setError(errorText(e));
          }
        }} />
      </div>
    </div>
  );
}

function Counter({ chars, limit }: { chars: number; limit: number | null }) {
  if (limit === null) return <span className="kb-me__count">{n(chars)} characters</span>;
  const over = chars - limit;
  return (
    <span className={`kb-me__count${over > 0 ? ' is-over' : ''}`} role={over > 0 ? 'alert' : undefined}>
      {n(chars)} / {n(limit)}{over > 0 ? ` · ${n(over)} over the limit` : ''}
    </span>
  );
}

function VersionRow({ v, current, busy, onRestore }: { v: KbMeVersion; current: boolean; busy: boolean; onRestore: () => void }) {
  const line = `Version ${v.version}`;
  return (
    <li className="kb-me__version" aria-label={line}>
      <div className="kb-me__vtext">
        <b>{line}</b>
        <span className="kb-muted"> · {SOURCE[v.source]} · {shortTime(v.created_at)} · {n(v.chars)} characters</span>
        {v.summary && <div className="kb-me__vsum">{v.summary}</div>}
      </div>
      {current ? <span className="kb-muted kb-me__current">Current</span>
        : <Button size="sm" icon="undo" busy={busy} onClick={onRestore} aria-label={`Restore version ${v.version}`}>Restore</Button>}
    </li>
  );
}

/** One skill opened: its text (edit and Save), its versions (Restore), Delete for a skill of your own. */
function SkillEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { client, settings } = useServices();
  const putSkill = usePutSkill();
  const [skill, setSkill] = useState<KbMeSkillDetail | null>(null);
  const [versions, setVersions] = useState<KbMeVersion[] | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '', text: '' });
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textId = useId();

  const show = (d: KbMeSkillDetail) => {
    setSkill(d);
    setDraft({ title: d.title, description: d.description, text: d.text });
    putSkill(d);
  };
  const loadVersions = async () => {
    try { setVersions((await meSkillVersions(client, id)).versions); } catch (e) { setError(errorText(e)); }
  };
  const load = async () => {
    setReadError(null);
    try {
      show(await readMeSkill(client, id));
      await loadVersions();
    } catch (e) {
      setReadError(errorText(e));
    }
  };
  // Read once per opened skill (`load` is recreated each render; the id is what matters).
  useEffect(() => { void load(); }, [id]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const back = <Button size="sm" variant="quiet" icon="chevronLeft" onClick={onBack}>Me</Button>;
  if (!skill) {
    return (
      <div className="kb-me__editor">
        {back}
        {readError ? <Failed error={readError} retry={() => void load()} /> : <Reading />}
      </div>
    );
  }
  const changed = draft.text !== skill.text || (!skill.builtin && (draft.title !== skill.title || draft.description !== skill.description));
  const over = skill.limit !== null && draft.text.length > skill.limit;
  const save = () => run('save', async () => {
    const body = skill.builtin ? { text: draft.text } : { title: draft.title, description: draft.description, text: draft.text };
    show(await updateMeSkill(client, skill.id, body));
    await loadVersions();
  });

  return (
    <section className="kb-me__editor" aria-label={skill.title}>
      <div className="kb-me__edhead">
        {back}
        <h4 className="kb-sgroup__title">{skill.title}</h4>
      </div>
      {skill.builtin ? (
        <p className="kb-sintro">{skill.description}</p>
      ) : (
        <div className="kb-me__fields">
          <TextField label="Name" value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <TextField label="One-line description" hint="Agents see this line and open the text when they need it."
            value={draft.description} maxLength={200} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
      )}
      <label className="kb-field__label" htmlFor={textId}>Text</label>
      <textarea id={textId} className="kb-attachform__input kb-attachform__area kb-me__text" rows={10} value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      <div className="kb-me__foot">
        <Counter chars={draft.text.length} limit={skill.limit} />
        <span className="kb-me__spacer" />
        {changed && <Button size="sm" variant="quiet" onClick={() => setDraft({ title: skill.title, description: skill.description, text: skill.text })}>Discard</Button>}
        <Button size="sm" variant="fill" busy={busy === 'save'} disabled={!changed || over || !!busy} onClick={() => void save()}>Save</Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}

      <section className="kb-sgroup" aria-label="Versions">
        <h4 className="kb-sgroup__title">Versions</h4>
        {versions === null ? <Reading /> : versions.length === 0 ? <p className="kb-muted kb-me__empty">Nothing written yet.</p> : (
          <ul className="kb-me__versions">
            {versions.map((v) => (
              <VersionRow key={v.version} v={v} current={v.version === skill.version} busy={busy === `restore-${v.version}`}
                onRestore={() => void run(`restore-${v.version}`, async () => {
                  show(await restoreMeVersion(client, skill.id, v.version));
                  await loadVersions();
                })} />
            ))}
          </ul>
        )}
      </section>

      {!skill.builtin && (
        <div className="kb-me__delete">
          {confirmDelete ? (
            <div role="group" aria-label="Delete this skill?" className="kb-me__confirm">
              <span>Delete “{skill.title}” and its versions? Agents stop seeing it.</span>
              <Button size="sm" variant="danger" busy={busy === 'delete'} onClick={() => void run('delete', async () => {
                await deleteMeSkill(client, skill.id);
                await settings.getState().loadMe();
                onBack();
              })}>Delete skill</Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          ) : (
            <Button size="sm" icon="trash" onClick={() => setConfirmDelete(true)}>Delete…</Button>
          )}
        </div>
      )}
    </section>
  );
}

/** "New skill": a name, one line for the agent's index, the text. */
function NewSkill({ onDone }: { onDone: (id: string | null) => void }) {
  const { client } = useServices();
  const putSkill = usePutSkill();
  const [draft, setDraft] = useState({ title: '', description: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await createMeSkill(client, { title: draft.title.trim(), description: draft.description.trim(), text: draft.text });
      putSkill(d);
      onDone(d.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-me__editor" aria-label="New skill">
      <div className="kb-me__edhead">
        <Button size="sm" variant="quiet" icon="chevronLeft" onClick={() => onDone(null)}>Me</Button>
        <h4 className="kb-sgroup__title">New skill</h4>
      </div>
      <div className="kb-me__fields">
        <TextField label="Name" value={draft.title} maxLength={80} autoFocus onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <TextField label="One-line description" hint="Agents see this line and open the text when they need it."
          value={draft.description} maxLength={200} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </div>
      <label className="kb-field__label" htmlFor={textId}>Text</label>
      <textarea id={textId} className="kb-attachform__input kb-attachform__area kb-me__text" rows={8} value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      <div className="kb-me__foot">
        <span className="kb-me__spacer" />
        <Button size="sm" variant="quiet" onClick={() => onDone(null)}>Cancel</Button>
        <Button size="sm" variant="fill" busy={busy} disabled={!draft.title.trim() || busy} onClick={() => void create()}>Create</Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </section>
  );
}

/** Settings → Me: the skills of «Я» (built-ins first), each switchable and open for editing; "New skill". */
export function MeSkills() {
  const { settings } = useServices();
  const me = useSettings((s) => s.me);
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'skill'; id: string } | { kind: 'new' }>({ kind: 'list' });
  if (view.kind === 'skill') return <SkillEditor id={view.id} onBack={() => setView({ kind: 'list' })} />;
  if (view.kind === 'new') return <NewSkill onDone={(id) => setView(id ? { kind: 'skill', id } : { kind: 'list' })} />;
  return (
    <section className="kb-sgroup" aria-label="Skills of Me">
      <div className="kb-me__listhead">
        <h4 className="kb-sgroup__title">Skills</h4>
        <Button size="sm" icon="plus" onClick={() => setView({ kind: 'new' })}>New skill</Button>
      </div>
      {!me.value ? (
        me.error ? <Failed error={me.error} retry={() => void settings.getState().loadMe()} /> : <Reading />
      ) : (
        <div className={me.value.enabled ? undefined : 'kb-me__off'}>
          {me.value.skills.map((skill) => <SkillRow key={skill.id} skill={skill} onOpen={() => setView({ kind: 'skill', id: skill.id })} />)}
        </div>
      )}
    </section>
  );
}

/** What «Я» is (top of the section) and the honest storage line (decision 5, bottom). */
export function MeIntro() {
  return (
    <p className="kb-sintro">
      What agents know about you and how you like to work. Agents add to it only from your own messages; every change shows in the chat with Undo.
    </p>
  );
}

export function MeStorageNote() {
  return <p className="kb-snote kb-snote--quiet"><Icon name="shield" size={14} />{ME_STORAGE_NOTE}</p>;
}
