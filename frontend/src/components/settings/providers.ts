import type { CloudProviderName, LocalProviderName, ProviderName, TaskKind } from '../../api/types';

// Shared between ProfileEditor (Model assignment) and ProviderCredentials
// (API keys): both need to know which providers exist per task and which
// providers are local (no credentials) vs. cloud (need a key).
export const PROVIDERS: Record<TaskKind, ProviderName[]> = {
  asr: ['local-whisper', 'local-gigachat-mlx', 'openai', 'openrouter'],
  agent: ['openrouter', 'openai', 'anthropic'],
  notes: ['openrouter', 'openai', 'anthropic'],
  embedding: ['openrouter'],
};

// The API keys section lists these unconditionally: a key belongs to a provider,
// so it can be stored before (or without) any task being assigned to it.
export const CLOUD_PROVIDERS: (CloudProviderName & ProviderName)[] = ['openrouter', 'openai', 'anthropic'];

export const TASK_LABELS: Record<TaskKind, string> = {
  asr: 'Transcription',
  agent: 'Assistant',
  notes: 'Notes',
  embedding: 'Embedding',
};

export const isLocalProvider = (p: ProviderName): p is LocalProviderName =>
  p === 'local-whisper' || p === 'local-gigachat-mlx';
export const needsKey = (p: ProviderName): boolean => !isLocalProvider(p);

/**
 * Where each provider issues API keys, so the user does not have to hunt for
 * the page. Soniox keys live per project, so its console is the deepest stable
 * address; the others open their key page directly (after sign-in).
 */
export const PROVIDER_KEY_URLS: Record<CloudProviderName, string> = {
  soniox: 'https://console.soniox.com/',
  openrouter: 'https://openrouter.ai/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://platform.claude.com/settings/keys',
};
