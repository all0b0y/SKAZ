import type { LocalProviderName, ProviderName, TaskKind } from '../../api/types';

// Shared between ProfileEditor (Model assignment) and ProviderCredentials
// (Providers): both need to know which providers exist per task and which
// providers are local (no credentials) vs. remote (need a key/base_url).
export const PROVIDERS: Record<TaskKind, ProviderName[]> = {
  asr: ['local-whisper', 'local-gigachat-mlx', 'openai', 'openrouter', 'openai-compatible'],
  agent: ['openrouter', 'openai', 'anthropic', 'openai-compatible'],
  notes: ['openrouter', 'openai', 'anthropic', 'openai-compatible'],
};

export const TASK_LABELS: Record<TaskKind, string> = {
  asr: 'Transcription',
  agent: 'Assistant',
  notes: 'Notes',
};

export const needsBaseUrl = (p: ProviderName): boolean => p === 'openai-compatible';
export const isLocalProvider = (p: ProviderName): p is LocalProviderName =>
  p === 'local-whisper' || p === 'local-gigachat-mlx';
export const needsKey = (p: ProviderName): boolean => !isLocalProvider(p);
