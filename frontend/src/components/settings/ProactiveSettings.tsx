import type { ProactiveSettings as Stored } from '../../api/types';

export interface ProactiveDraft {
  enabled?: boolean;
  /** Raw textarea text, one name per line; parsed only when saving. */
  aliasesText?: string;
  sound?: boolean;
  model_consent?: boolean;
}

export const EMPTY_PROACTIVE: Stored = { enabled: false, aliases: [], sound: false, model_consent: false };

export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    const alias = line.split(/\s+/).filter(Boolean).join(' ').slice(0, 60);
    if (alias && !seen.has(alias.toLocaleLowerCase())) {
      seen.add(alias.toLocaleLowerCase());
      result.push(alias);
    }
  }
  return result;
}

/** The effective values of the stored settings with the draft applied. */
export function effectiveProactive(stored: Stored | undefined, draft: ProactiveDraft) {
  const base = stored ?? EMPTY_PROACTIVE;
  const aliases = draft.aliasesText !== undefined ? parseAliases(draft.aliasesText) : base.aliases;
  const enabled = draft.enabled ?? base.enabled;
  const consent = draft.model_consent ?? base.model_consent;
  const problem = !enabled ? null
    : aliases.length === 0 ? 'Add at least one name, nickname or code phrase.'
      : !consent ? 'Allow sending transcript text to the Assistant model.'
        : aliases.length > 20 ? 'Use at most 20 names and phrases.' : null;
  return { enabled, aliases, consent, sound: draft.sound ?? base.sound, problem };
}

/** Only the changed fields, in the shape PUT /settings accepts. */
export function proactiveUpdate(stored: Stored | undefined, draft: ProactiveDraft): Partial<Stored> | null {
  const next = effectiveProactive(stored, draft);
  const update: Partial<Stored> = {};
  if (draft.enabled !== undefined) update.enabled = next.enabled;
  if (draft.aliasesText !== undefined) update.aliases = next.aliases;
  if (draft.sound !== undefined) update.sound = next.sound;
  if (draft.model_consent !== undefined) update.model_consent = next.consent;
  return Object.keys(update).length ? update : null;
}

export function ProactiveSettingsSection({ stored, draft, onChange, disabled, agentModel }: {
  stored: Stored | undefined;
  draft: ProactiveDraft;
  onChange: (draft: ProactiveDraft) => void;
  disabled: boolean;
  /** The Assistant model that prepares answers, or '' when none is chosen. */
  agentModel: string;
}) {
  const base = stored ?? EMPTY_PROACTIVE;
  const current = effectiveProactive(stored, draft);
  const aliasesText = draft.aliasesText ?? base.aliases.join('\n');
  const change = (patch: ProactiveDraft) => onChange({ ...draft, ...patch });
  return (
    <section className="settings-section" aria-label="Proactive assistant">
      <h3 className="settings-section__title">Proactive assistant</h3>
      <p className="field__hint">
        During a live recording, SKAZ notices when someone addresses you by one of your names and asks a
        question or makes a request. It shows the question as it was heard and, once the question is finished,
        the context and a draft answer built only from what was said, with links to the transcript.
        Mentions of you in the third person and plain statements do not trigger it. Imported recordings never do.
      </p>
      <div className="field field--row">
        <div>
          <label htmlFor="proactive-enabled">Enable the proactive assistant</label>
          <p className="field__hint">Off by default. It never answers on your behalf.</p>
        </div>
        <input id="proactive-enabled" type="checkbox" className="field__switch" checked={current.enabled}
          disabled={disabled} onChange={(event) => change({ enabled: event.target.checked })} />
      </div>
      <div className="field">
        <label htmlFor="proactive-aliases">Your names, nicknames and code phrases</label>
        <textarea id="proactive-aliases" rows={4} value={aliasesText} disabled={disabled}
          placeholder={'Alex\nАлекс\nСаша'}
          onChange={(event) => change({ aliasesText: event.target.value })} />
        <span className="field__hint">
          One per line, up to 20. Include the forms people use to address you, for example “Саша” and “Александр”.
          They are removed from any web lookup.
        </span>
      </div>
      <label className="consent">
        <input type="checkbox" checked={current.consent} disabled={disabled}
          onChange={(event) => change(event.target.checked
            ? { model_consent: true }
            : { model_consent: false, enabled: false })} />
        <span>
          <strong>Send transcript text to the Assistant model automatically</strong>
          <span className="field__hint">
            When a question to you is detected, the recent transcript is sent to
            {agentModel ? ` ${agentModel}` : ' the Assistant model (none is chosen yet — see Assistant)'} without
            you pressing anything. Provider charges and policies apply; cloud processing must be allowed too.
            Turning the assistant off for a session stops every automatic call for that session.
          </span>
        </span>
      </label>
      <div className="field field--row">
        <div>
          <label htmlFor="proactive-sound">Sound</label>
          <p className="field__hint">
            When SKAZ is not in focus you get a system notification without any conversation content.
            Sound is off by default.
          </p>
        </div>
        <input id="proactive-sound" type="checkbox" className="field__switch" checked={current.sound}
          disabled={disabled} onChange={(event) => change({ sound: event.target.checked })} />
      </div>
      {current.problem && <p role="alert" className="field__error">{current.problem}</p>}
    </section>
  );
}
