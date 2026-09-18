import type { CloudProviderName, LocalProviderName, ProviderName, TaskKind } from '../../api/types';

// Shared between ProfileEditor (Model assignment) and ProviderCredentials
// (API keys): both need to know which providers exist per task and which
// providers are local (no credentials) vs. cloud (need a key).
export const PROVIDERS: Record<TaskKind, ProviderName[]> = {
  asr: ['local-whisper', 'local-gigachat-mlx', 'openai', 'openrouter'],
  agent: ['openrouter', 'openai', 'anthropic'],
  notes: ['openrouter', 'openai', 'anthropic'],
};

// The API keys section lists these unconditionally: a key belongs to a provider,
// so it can be stored before (or without) any task being assigned to it.
export const CLOUD_PROVIDERS: (CloudProviderName & ProviderName)[] = ['openrouter', 'openai', 'anthropic'];

export const TASK_LABELS: Record<TaskKind, string> = {
  asr: 'Transcription',
  agent: 'Assistant',
  notes: 'Notes',
};

export const isLocalProvider = (p: ProviderName): p is LocalProviderName =>
  p === 'local-whisper' || p === 'local-gigachat-mlx';
export const needsKey = (p: ProviderName): boolean => !isLocalProvider(p);
