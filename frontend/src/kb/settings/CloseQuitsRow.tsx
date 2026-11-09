import { useEffect, useState } from 'react';
import { Switch } from '../ui';
import { useServices } from '../state/context';

/**
 * Settings → About → "Closing the window quits SKAZ" (decision 3f′). Off by default: closing keeps SKAZ in the
 * tray. Main holds the setting, because it decides on the close; the switch shows what main answers, never a
 * state that didn't take.
 */
export function CloseQuitsRow({ label }: { label: string }) {
  const { bridge } = useServices();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge.getCloseQuits) return undefined;
    let live = true;
    void bridge.getCloseQuits().then(
      (value) => { if (live) setOn(value); },
      () => { if (live) setError('Couldn’t read this setting.'); },
    );
    return () => { live = false; };
  }, [bridge]);

  if (!bridge.getCloseQuits || !bridge.setCloseQuits) return <span className="kb-muted">Works in the SKAZ desktop app.</span>;
  if (on === null) {
    return error
      ? <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>
      : <span className="kb-muted" role="status">Reading…</span>;
  }

  const change = async (next: boolean) => {
    const held = await bridge.setCloseQuits!(next).catch(() => on);
    setOn(held);
    setError(held === next ? null : 'Couldn’t save this setting. Try again.');
  };
  return (
    <>
      <Switch label={label} checked={on} onChange={(next) => void change(next)} />
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </>
  );
}
