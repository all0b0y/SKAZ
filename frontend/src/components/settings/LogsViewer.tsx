import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';

// Settings → Logs. Reads the desktop app log written by Electron; the browser
// dev build has no bridge, so the panel says so instead of pretending.

const LEVELS = ['ALL', 'INFO', 'WARNING', 'ERROR'] as const;
type Level = (typeof LEVELS)[number];

const REFRESH_MS = 3_000;

/** Keep a line when it matches the filter, or when nothing is filtered. */
export function filterLines(text: string, level: Level): string[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (level === 'ALL') return lines;
  if (level === 'WARNING') return lines.filter((l) => l.includes(' WARNING ') || l.includes(' ERROR '));
  if (level === 'ERROR') return lines.filter((l) => l.includes(' ERROR '));
  return lines;
}

export function LogsViewer() {
  const bridge = typeof window === 'undefined' ? undefined : window.audiohelper;
  const supported = typeof bridge?.readLogs === 'function';

  const [text, setText] = useState('');
  const [level, setLevel] = useState<Level>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setText(await bridge!.readLogs!());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [bridge, supported]);

  useEffect(() => {
    void refresh();
    if (!supported) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, supported]);

  if (!supported) {
    return (
      <p className="profile__note">
        Logs are available only in the desktop app — the browser build writes no file.
      </p>
    );
  }

  const lines = filterLines(text, level);

  return (
    <div className="logs">
      <div className="logs__bar">
        <div className="field">
          <label htmlFor="log-level">Level</label>
          <select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
            {LEVELS.map((value) => (
              <option key={value} value={value}>{value === 'ALL' ? 'All' : value}</option>
            ))}
          </select>
        </div>
        <div className="logs__actions">
          <Button variant="ghost" onClick={() => void refresh()}>Refresh</Button>
          <Button
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(lines.join('\n'));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {typeof bridge?.openLogsFolder === 'function' && (
            <Button variant="ghost" onClick={() => void bridge.openLogsFolder!()}>Open folder</Button>
          )}
        </div>
      </div>

      {error && <p className="profile__note profile__note--warn">{error}</p>}

      {lines.length === 0 ? (
        <p className="profile__note">No entries yet.</p>
      ) : (
        <pre className="logs__output" aria-label="App logs">{lines.join('\n')}</pre>
      )}

      <p className="field__hint">
        INFO and above is written. Transcript text, assistant answers and keys never
        reach the file. The file is size-limited and rotates.
      </p>
    </div>
  );
}
