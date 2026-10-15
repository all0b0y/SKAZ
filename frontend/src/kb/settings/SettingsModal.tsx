import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Banner, Button, Icon, Modal, PathText, Segmented } from '../ui';
import { usePrefs, useLibrary, useServices, useUi } from '../state/context';
import type { SettingsSection } from '../state/ui';
import type { TextSize, ThemePref } from '../state/prefs';
import { useProblems } from '../shell/problems';
import {
  AgentRow, AsrRow, BackgroundLinksRow, ChatModelRow, DecisionsRow, DefaultAgentRow, FindLinksNowRow, HealthPlates, KeyRow,
  Licenses, LocalDecisionsRow, LocalWhisperRow, NotYet, PrivacyRow, SonioxConsentRow, SpeechLanguagesRow, TranslationRow, VersionRow,
  WikiLanguageRow, WikiModelRow, WikiSwitchRow,
} from './LiveRows';
import { EngineBadge } from '../ui/EngineBadge';
import type { EngineId } from '../api/names';
import { NAV, ROWS, SECTION_LABEL, searchRows, type RowDef } from './schema';
import { version as appVersion } from '../../../../package.json';

/**
 * The control of one settings row: live backend data where the route exists (S3/W2/B7 via
 * `LiveRows`), an honest "Not connected yet" where it does not — never a dummy button.
 */
function RowControl({ row }: { row: RowDef }) {
  const { prefs } = useServices();
  const theme = usePrefs((s) => s.theme);
  const textSize = usePrefs((s) => s.textSize);
  const library = useLibrary((s) => s.library);
  const setLibrarySetupOpen = useUi((s) => s.setLibrarySetupOpen);
  switch (row.id) {
    case 'agent-codex': return <AgentRow engine="codex" />;
    case 'agent-claude': return <AgentRow engine="claude_code" />;
    case 'agent-hermes': return <AgentRow engine="hermes" />;
    case 'key-openrouter': return <KeyRow provider="openrouter" />;
    case 'key-soniox': return <KeyRow provider="soniox" />;
    case 'local-whisper': return <LocalWhisperRow />;
    case 'local-decisions': return <LocalDecisionsRow />;
    case 'default-agent': return <DefaultAgentRow label={row.label} />;
    case 'chat-model': return <ChatModelRow />;
    case 'wiki-model': return <WikiModelRow label={row.label} />;
    case 'decisions': return <DecisionsRow label={row.label} />;
    case 'asr-service': return <AsrRow label={row.label} />;
    case 'soniox-consent': return <SonioxConsentRow label={row.label} />;
    case 'speech-languages': return <SpeechLanguagesRow />;
    case 'translate-default': return <TranslationRow />;
    case 'wiki-language': return <WikiLanguageRow />;
    case 'auto-files': return <WikiSwitchRow field="auto_add_files_links" label={row.label} />;
    case 'auto-text': return <WikiSwitchRow field="auto_add_text" label={row.label} />;
    case 'auto-fix': return <WikiSwitchRow field="auto_corrections" label={row.label} />;
    case 'bg-links': return <BackgroundLinksRow label={row.label} />;
    case 'links-now': return <FindLinksNowRow />;
    case 'lib-folder':
      if (library?.state === 'ready' || library?.state === 'unavailable') {
        return (
          <>
            <PathText path={library.root ?? ''} />
            <Button size="sm" onClick={() => setLibrarySetupOpen(true)}>Change…</Button>
          </>
        );
      }
      return (
        <>
          <span className="kb-warn-text">Not connected</span>
          <Button size="sm" variant="fill" onClick={() => setLibrarySetupOpen(true)}>Choose…</Button>
        </>
      );
    case 'p-soniox':
      return <PrivacyRow rowId={row.id} fallback="sound of recordings, when Soniox is chosen" />;
    case 'p-agent':
      return <PrivacyRow rowId={row.id} fallback="material text in your questions and while building the wiki" />;
    case 'p-openrouter':
      return <PrivacyRow rowId={row.id} fallback="only if you choose it" />;
    case 'p-local':
      return <PrivacyRow rowId={row.id} fallback="everything else" />;
    case 'theme':
      return (
        <Segmented<ThemePref> label="Theme" value={theme} size="sm" onChange={(v) => prefs.getState().set({ theme: v })}
          options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      );
    case 'text-size':
      return (
        <Segmented<TextSize> label="Text size" value={textSize} size="sm" onChange={(v) => prefs.getState().set({ textSize: v })}
          options={[{ value: 's', label: 'S', name: 'Small' }, { value: 'm', label: 'M', name: 'Medium' }, { value: 'l', label: 'L', name: 'Large' }]} />
      );
    case 'ui-language':
      return <span className="kb-muted">English</span>;
    case 'version':
      return <VersionRow fallback={appVersion} />;
    case 'github':
      return (
        <a className="kb-link" href="https://github.com/all0b0y/SKAZ" target="_blank" rel="noreferrer noopener">
          all0b0y/SKAZ<Icon name="external" size={12} />
        </a>
      );
    default:
      return <NotYet />;
  }
}

const ENGINE_OF_ROW: Record<string, EngineId | undefined> = { 'agent-codex': 'codex', 'agent-claude': 'claude_code', 'agent-hermes': 'hermes' };

function Row({ row }: { row: RowDef }) {
  const labelId = useId();
  return (
    <div className="kb-srow" data-row={row.id} role="group" aria-labelledby={labelId}>
      <div className="kb-srow__text">
        <div id={labelId} className="kb-srow__label">{ENGINE_OF_ROW[row.id] && <EngineBadge engine={ENGINE_OF_ROW[row.id]!} />}{row.label}</div>
        {row.hint && <div className="kb-srow__hint">{row.hint}</div>}
      </div>
      <div className="kb-srow__control"><RowControl row={row} /></div>
    </div>
  );
}

function groupsOf(rows: ReadonlyArray<RowDef>): Array<{ title: string; rows: RowDef[] }> {
  const out: Array<{ title: string; rows: RowDef[] }> = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.title === row.group) last.rows.push(row);
    else out.push({ title: row.group, rows: [row] });
  }
  return out;
}

function StorageBanner() {
  const library = useLibrary((s) => s.library);
  const libraryLoad = useLibrary((s) => s.libraryLoad);
  const libraryError = useLibrary((s) => s.libraryError);
  const { library: store } = useServices();
  const setLibrarySetupOpen = useUi((s) => s.setLibrarySetupOpen);
  const [busy, setBusy] = useState(false);
  if (libraryLoad === 'error') {
    return (
      <Banner tone="error" title="Couldn’t read the library state."
        actions={<Button size="sm" variant="fill" icon="retry" onClick={() => void store.getState().loadLibrary()}>Try again</Button>}>
        {libraryError}
      </Banner>
    );
  }
  if (library?.state === 'not_configured') {
    return (
      <Banner tone="warning" title="The library isn’t connected."
        actions={<Button size="sm" variant="fill" onClick={() => setLibrarySetupOpen(true)}>Choose where to keep it</Button>}>
        Until it is, materials can’t be added and the wiki stays empty. Settings still work.
      </Banner>
    );
  }
  if (library?.state === 'unavailable') {
    return (
      <Banner tone="error" title="The library folder is unavailable."
        actions={(
          <>
            <Button size="sm" variant="fill" icon="retry" busy={busy}
              onClick={async () => { setBusy(true); await store.getState().retry(); setBusy(false); }}>Try again</Button>
            <Button size="sm" onClick={() => setLibrarySetupOpen(true)}>Choose another place</Button>
          </>
        )}>
        {library.reason} Materials and the wiki can’t be opened until it is back. Nothing was deleted.
      </Banner>
    );
  }
  return null;
}

function SectionBody({ section }: { section: SettingsSection }) {
  const rows = ROWS.filter((r) => r.section === section);
  return (
    <>
      {section === 'storage' && <StorageBanner />}
      <HealthPlates section={section} />
      {groupsOf(rows).map((g, i) => (
        <section key={`${g.title}-${i}`} className="kb-sgroup" aria-label={g.title || undefined}>
          {g.title && <h4 className="kb-sgroup__title">{g.title}</h4>}
          {g.rows.map((row) => <Row key={row.id} row={row} />)}
        </section>
      ))}
      {section === 'models' && (
        <p className="kb-snote"><Icon name="warning" size={14} />If the chosen model is unavailable, SKAZ says so and never switches to another on its own.</p>
      )}
      {section === 'about' && <Licenses />}
    </>
  );
}

/** Settings window (decision 30): modal over the app, ⌘, opens it; flat list layout (decision 31). */
export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const section = useUi((s) => s.settingsSection);
  const close = useUi((s) => s.closeSettings);
  const setSection = useUi((s) => s.setSettingsSection);
  const problems = useProblems();
  const { settings, agents } = useServices();

  // Fresh live data each time the window opens (cheap reads; the backend owns the truth).
  useEffect(() => {
    if (!open) return;
    const s = settings.getState();
    void s.loadHealth();
    void s.loadKeys();
    void s.loadSpeech();
    void s.loadWiki();
    void s.loadDecisions();
    void s.loadPrivacy();
    void s.loadAbout();
    void agents.getState().refresh();
  }, [open, settings, agents]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const results = query.trim() ? searchRows(query) : null;
  const flagged = new Map(problems.map((p) => [p.section, p.tone] as const));

  return (
    <Modal open={open} onClose={() => { setQuery(''); close(); }} title="Settings" className="kb-settings" testId="settings" pane="settings"
      initialFocusRef={searchRef}>
      <div className="kb-settings__body">
        <nav className="kb-settings__nav" aria-label="Settings sections">
          <div className="kb-settings__search">
            <Icon name="search" size={14} />
            <label className="kb-visually-hidden" htmlFor="kb-settings-search">Find a setting</label>
            <input
              id="kb-settings-search"
              ref={searchRef}
              type="search"
              placeholder="Find a setting"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
              }}
            />
          </div>
          {NAV.map((g) => (
            <Fragment key={g.group}>
              <h3 className="kb-settings__group">{g.group}</h3>
              <ul className="kb-settings__items">
                {g.items.map((item) => {
                  const current = !results && item.id === section;
                  const tone = flagged.get(item.id);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`kb-row${current ? ' is-current' : ''}`}
                        aria-current={current ? 'page' : undefined}
                        data-settings-section={item.id}
                        onClick={() => { setQuery(''); setSection(item.id); }}
                      >
                        <Icon name={item.icon} size={16} className="kb-row__icon" />
                        <span className="kb-row__text">{item.label}</span>
                        {tone && <span className={`kb-dot kb-dot--${tone}`} aria-label="Needs attention" role="img" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          ))}
        </nav>
        <div className="kb-settings__content">
          {results ? (
            <>
              <h3 className="kb-settings__title">Search</h3>
              <p role="status" className="kb-visually-hidden">
                {results.length === 1 ? '1 setting found' : `${results.length} settings found`}
              </p>
              {results.length === 0 ? (
                <p className="kb-muted">No settings match “{query.trim()}”.</p>
              ) : groupsOf(results.map((r) => ({ ...r, group: SECTION_LABEL[r.section] }))).map((g) => (
                <section key={g.title} className="kb-sgroup" aria-label={g.title}>
                  <h4 className="kb-sgroup__title">{g.title}</h4>
                  {g.rows.map((row) => <Row key={row.id} row={ROWS.find((r) => r.id === row.id)!} />)}
                </section>
              ))}
            </>
          ) : (
            <>
              <h3 className="kb-settings__title">{SECTION_LABEL[section]}</h3>
              <SectionBody section={section} />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
