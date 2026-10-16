import { useEffect, useState } from 'react';
import { webSearch, type SearchSettings } from '../../api/webSearch';

export function WebSearchSettings() {
  const [view, setView] = useState<SearchSettings | null>(null);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let alive = true;
    void webSearch.settings().then((v) => {
      if (alive) { setView(v); setEnabled(v.enabled); }
    }).catch(() => { if (alive) setError('Could not read search settings.'); });
    return () => { alive = false; };
  }, []);
  async function save(remove = false) {
    setBusy(true); setError(''); setSaved(false);
    try {
      const v = await webSearch.configure(remove ? false : enabled, remove ? '' : key || undefined);
      setView(v); setEnabled(v.enabled); setKey(''); setSaved(true);
    } catch { setError('Could not save. Enabling requires a Brave Search API key.'); }
    finally { setBusy(false); }
  }
  return <section className="settings-section" aria-label="Web Search">
    <h3 className="settings-section__title">Web Search · Brave</h3>
    <p className="field__hint">A separate Search API, not part of the Codex subscription. Billed under your Brave plan.
      Every request needs approval of the exact query. History, Notes and transcripts are not sent to the search API.
      This does not guarantee the provider keeps nothing.</p>
    <p className="field__hint">The tool is currently available to the Codex Assistant. Regular Notes work without internet.
      Search snippets with links are read, not full pages.</p>
    <label className="field"><span>Brave Search API key</span>
      <input type="password" autoComplete="off" value={key} disabled={busy || !view}
        placeholder={view?.has_key ? 'Key saved' : 'No key set'}
        onChange={(e) => { setKey(e.target.value); setSaved(false); }} />
    </label>
    <label className="consent"><input type="checkbox" checked={enabled} disabled={busy || !view}
      onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} />
      <span>Allow web search suggestions, approving each request</span></label>
    <div className="session-dialog__actions">
      <button className="btn" type="button" disabled={busy || !view} onClick={() => void save()}>Save search</button>
      {view?.has_key && <button className="btn btn--ghost" type="button" disabled={busy}
        onClick={() => void save(true)}>Remove search key</button>}
    </div>
    {saved && <p role="status">Search settings saved.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
