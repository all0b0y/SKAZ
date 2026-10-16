import type { StreamState } from './recordingStore';

/** Provider name for the connection line; the stream never switches provider on its own. */
export function speechServiceName(provider: string | null): string {
  if (provider === 'local-whisper') return 'Whisper on this computer';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'soniox' || !provider) return 'Soniox';
  return provider;
}

/** What the recording's speech connection is doing, when it isn't simply streaming. */
export function connectionText(stream: StreamState | null, provider: string | null): { short: string; long: string | null } | null {
  const name = speechServiceName(provider);
  if (stream === 'connecting') return { short: `Connecting to ${name}…`, long: null };
  if (stream === 'reconnecting') {
    return {
      short: `Reconnecting to ${name}…`,
      long: `The connection to ${name} dropped and SKAZ is reconnecting. Recording continues; up to 30 seconds of audio are kept and sent when the connection is back.`,
    };
  }
  return null;
}
