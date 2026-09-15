import type { NativeSnapshot } from '../../api/nativeLive';
import { formatTimecode } from '../../lib/time';

const exactTime = (ms: number): string => `${formatTimecode(ms)}.${String(Math.floor(ms) % 1000).padStart(3, '0')}`;
const labels: Record<NativeSnapshot['transcription'], string> = {
  connecting: 'Soniox: connecting', streaming: 'Soniox: transcribing',
  unavailable: 'Soniox: transcription unavailable — audio is still saved locally',
  inactive: 'Soniox: not active',
  disabled: 'Audio-only recording — transcription is disabled',
};

function draft(connection: NativeSnapshot['connections'][number], sampleRate: number) {
  try {
    const tokens: unknown = JSON.parse(connection.draft_json);
    if (!Array.isArray(tokens) || !tokens.every((t: unknown) => typeof t === 'object' && t !== null && 'text' in t && typeof t.text === 'string')) {
      return { text: '', time: null, invalid: true };
    }
    const text = tokens.map((t: { text: string }) => t.text).join('');
    const first = tokens.find((t: { start_ms?: unknown }) => typeof t.start_ms === 'number' && Number.isFinite(t.start_ms) && t.start_ms >= 0);
    return { text, time: first ? connection.start_sample * 1000 / sampleRate + first.start_ms : null, invalid: false };
  } catch {
    return { text: '', time: null, invalid: true };
  }
}

export function NativeTranscriptStatus({ snapshot, error, finalizing, onRetry }: {
  snapshot: NativeSnapshot | null; error: string | null; finalizing: boolean; onRetry: () => void;
}) {
  if (!snapshot && !error) return null;
  return (
    <section className="profile" aria-label="Soniox transcription">
      {error && <div><p role="alert" className="profile__note profile__note--warn">{error}</p>
        <button type="button" className="profile__download" onClick={onRetry}>Refresh Soniox status</button>
      </div>}
      {snapshot && <>
        <p role="status">{snapshot.recording_mode === 'audio_only' ? labels.disabled : labels[snapshot.transcription]}</p>
        <p className="profile__note">Audio saved through {exactTime(snapshot.saved_samples * 1000 / snapshot.sample_rate)}.</p>
        {finalizing && <p role="status">Saving audio / finalizing transcription…</p>}
        {snapshot.recording_mode !== 'audio_only' && snapshot.connections.some((c) => c.status === 'incomplete') && <p className="profile__note profile__note--warn">Transcription finalization incomplete.</p>}
        {snapshot.gaps.length > 0 && <div aria-label="Unconfirmed transcription ranges">
          <p>Ranges without complete confirmed transcription — not verified silence:</p>
          <ul>{snapshot.gaps.map((gap, index) => <li key={`${gap.start_sample}-${gap.end_sample}-${index}`}>
            {exactTime(gap.start_sample * 1000 / snapshot.sample_rate)}–{exactTime(gap.end_sample * 1000 / snapshot.sample_rate)}
          </li>)}</ul>
        </div>}
        {snapshot.connections.map((connection) => {
          const value = draft(connection, snapshot.sample_rate);
          if (value.invalid) return <p key={connection.id} role="alert">Stored draft could not be read.</p>;
          if (!value.text.trim()) return null;
          return <div key={connection.id} className="transcript__draft-inline" aria-label="Unconfirmed Soniox draft">
            <span className="tabular">{value.time !== null ? exactTime(value.time) : 'Time unavailable'}</span>{' '}
            <strong>Draft — not used for answers or notes. </strong>
            <span className="transcript__draft-text">{value.text}</span>
          </div>;
        })}
      </>}
    </section>
  );
}
