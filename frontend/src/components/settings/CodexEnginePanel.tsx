import { useState } from 'react';
import { useCodex } from '../../state/codex';
import { PURPOSE_KEYS, type CodexConnection, type CodexPurpose, type CodexSettings } from '../../api/codex';
import { Button } from '../ui/Button';

function connectionText(c: CodexConnection | null): string {
  switch (c?.status) {
    case 'connected': return `Connected${c.version ? ` · Codex ${c.version}` : ''}`;
    case 'signed_out': return `Codex found${c.version ? ` (${c.version})` : ''}, not signed in to ChatGPT`;
    case 'missing': return 'Codex was not found on this computer';
    case 'incompatible': return `Incompatible Codex version${c.version ? ` ${c.version}` : ''}`;
    case 'error': return `Check failed: ${c.error ?? 'no details'}`;
    default: return 'Not checked';
  }
}

interface CodexEnginePanelProps {
  purpose: CodexPurpose;
  /** Stored settings with this drawer's unsaved choices applied; null until read. */
  settings: CodexSettings | null;
  disabled: boolean;
  onChange: (patch: Partial<CodexSettings>) => void;
}

/**
 * The Codex tab of Assistant or Notes. One account serves both purposes; the
 * model and reasoning depth are this purpose's own and come only from the
 * catalog the connected Codex returned. Nothing here starts a task: checking
 * reads the local binary and account, signing in opens the official page after
 * consent, and choices are saved with the drawer's Save changes.
 */
export function CodexEnginePanel({ purpose, settings, disabled, onChange }: CodexEnginePanelProps) {
  const availability = useCodex((s) => s.availability);
  const connection = useCodex((s) => s.connection);
  const connecting = useCodex((s) => s.connecting);
  const error = useCodex((s) => s.error);
  const loginWatch = useCodex((s) => s.loginWatch);
  const codex = useCodex.getState;
  const [consent, setConsent] = useState(false);

  if (availability !== 'available' || !settings) {
    return <p className="field__hint">Reading Codex status…</p>;
  }

  const keys = PURPOSE_KEYS[purpose];
  const model = settings[keys.model];
  const effort = settings[keys.effort];
  const connected = connection?.status === 'connected';
  const waiting = loginWatch.phase === 'waiting';

  return (
    <div className="codex-engine">
      <div className="codex-engine__status">
        <div>
          <label>Connection</label>
          <p className="field__hint" data-testid="codex-connection">{connectionText(connection)}</p>
        </div>
        {!waiting && (
          <Button variant="ghost" disabled={connecting} onClick={() => void codex().checkConnection()}>
            {connecting ? 'Checking…' : connection?.status === 'unchecked' ? 'Check connection' : 'Check again'}
          </Button>
        )}
      </div>

      {connection?.status === 'missing' && (
        <p className="field__hint">
          {connection.install_available
            ? 'Installation is available, but this version of SKAZ does not expose it in the interface yet.'
            : 'Installing Codex from SKAZ is not available yet. If Codex is already installed, check the connection again; SKAZ does not change an existing installation.'}
        </p>
      )}
      {connection?.status === 'incompatible' && (
        <p className="field__hint">SKAZ does not update Codex itself. A compatible version is required.</p>
      )}
      {connection && !connection.web_available && (
        <p className="field__hint">
          Codex web search is off: its built-in search cannot guarantee that only an approved query is sent.
          A separate search with per-query approval is configured under Web Search.
        </p>
      )}

      {connection?.status === 'signed_out' && (
        <div className="codex-engine__consent">
          <p>
            Signing in with ChatGPT opens the official page in your browser. SKAZ never asks for your password and does not
            use sign-ins or tokens of other apps.
          </p>
          <p>
            With a subscription, the transcript excerpts, Notes and questions that Codex reads
            are sent to OpenAI and may be retained under ChatGPT/Codex terms. Zero data retention (ZDR) is not
            guaranteed. We recommend turning off training on your data in ChatGPT settings
            (Data Controls) — SKAZ cannot check this setting for you. Usage counts against your subscription limits.
          </p>
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I understand the terms and want to connect my account</span>
          </label>
          <Button variant="primary" disabled={!consent || connecting} onClick={() => void codex().login()}>
            {waiting ? 'Open the sign-in page again' : 'Sign in with ChatGPT'}
          </Button>
          {waiting && (
            <p className="field__hint" role="status">
              The sign-in page is open. Finish signing in in your browser — the connection updates by itself.
            </p>
          )}
        </div>
      )}
      {loginWatch.phase === 'failed' && (
        <p className="profile__note profile__note--warn" role="alert">{loginWatch.message}</p>
      )}

      {connected && (
        <>
          <div className="codex-engine__account">
            <p className="field__hint">One account is used for Assistant and Notes.</p>
            <Button variant="ghost" disabled={connecting} onClick={() => void codex().logout()}>Sign out</Button>
          </div>
          <ModelAndEffort id={`codex-${purpose}`} connection={connection} model={model} effort={effort}
            disabled={disabled}
            onChange={(nextModel, nextEffort) => onChange({ [keys.model]: nextModel, [keys.effort]: nextEffort })} />
        </>
      )}
      {!connected && model && (
        <p className="field__hint">Saved: {model}{effort ? ` · ${effort}` : ''}. Models appear once connected.</p>
      )}

      {purpose === 'assistant' && (
        <label className="consent">
          <input type="checkbox" checked={settings.ask_before_large} disabled={disabled}
            onChange={(e) => onChange({ ask_before_large: e.target.checked })} />
          <span>
            <strong>Ask before large tasks</strong>
            <span className="field__hint">Note edits still require confirmation.</span>
          </span>
        </label>
      )}
      <p className="field__hint">
        No automatic fallback to the API or another model: on an error or limit SKAZ tells you.
        Existing API settings are kept.
      </p>
      {error && <p className="profile__note profile__note--warn" role="alert">{error}</p>}
    </div>
  );
}

interface ModelAndEffortProps {
  id: string;
  connection: CodexConnection;
  model: string;
  effort: string;
  disabled: boolean;
  onChange: (model: string, effort: string) => void;
}

/** A model, then its reasoning depth below it — both only from the returned catalog. */
function ModelAndEffort({ id, connection, model, effort, disabled, onChange }: ModelAndEffortProps) {
  const models = connection.models;
  const known = models.find((m) => m.id === model);
  const efforts = known?.efforts ?? [];
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-model`}>Codex model</label>
        <select id={`${id}-model`} value={model} disabled={disabled}
          onChange={(e) => {
            const next = models.find((m) => m.id === e.target.value);
            // An effort the new model does not offer is cleared, never swapped for another.
            onChange(e.target.value, next?.efforts.includes(effort) ? effort : '');
          }}>
          <option value="">Not selected</option>
          {model && !known && <option value={model}>{model} (unavailable in the connected version)</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-effort`}>Reasoning effort</label>
        <select id={`${id}-effort`} value={effort} disabled={disabled || !known}
          onChange={(e) => onChange(model, e.target.value)}>
          <option value="">Not selected</option>
          {effort && !efforts.includes(effort) && <option value={effort}>{effort} (unavailable)</option>}
          {efforts.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      {models.length === 0 && <p className="field__hint">The connected Codex returned no models.</p>}
      {(!model || !effort) && (
        <p className="field__hint">Codex will not start a task without a model and effort. No other model is substituted.</p>
      )}
    </>
  );
}
