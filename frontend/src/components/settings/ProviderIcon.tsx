import { siAnthropic, siOpenrouter, siClaudecode } from 'simple-icons';
import type { ProviderName } from '../../api/types';

/**
 * Real brand marks only. simple-icons has no icon for "openai" (removed from
 * the library), and openai-compatible / local-whisper / local-gigachat-mlx are
 * not brands at all — inventing a logo for them would be dishonest. Those
 * fall back to a plain initial badge instead (see ProviderIcon below).
 */
const BRAND_ICONS: Partial<Record<ProviderName, { path: string; hex: string; title: string }>> = {
  anthropic: { path: siAnthropic.path, hex: siAnthropic.hex, title: siAnthropic.title },
  openrouter: { path: siOpenrouter.path, hex: siOpenrouter.hex, title: siOpenrouter.title },
  'claude-code': { path: siClaudecode.path, hex: siClaudecode.hex, title: siClaudecode.title },
};

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  'local-whisper': 'Local Whisper',
  'local-gigachat-mlx': 'GigaChat (local)',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  'claude-code': 'Claude Code',
};

export function ProviderIcon({ provider, size = 18 }: { provider: ProviderName; size?: number }) {
  const brand = BRAND_ICONS[provider];
  if (brand) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={brand.title}
        style={{ color: `#${brand.hex}` }}
      >
        <path fill="currentColor" d={brand.path} />
      </svg>
    );
  }
  // No real logo exists for this provider — an honest initial badge, not a guess.
  const initial = PROVIDER_LABELS[provider].charAt(0);
  return (
    <span className="provider-icon--fallback" style={{ width: size, height: size, fontSize: size * 0.6 }} aria-hidden="true">
      {initial}
    </span>
  );
}
