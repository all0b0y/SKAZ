import { KbApiError } from '../api/client';

export interface ExploreIssue { message: string; settings?: boolean }

/** API detail can contain provider text. Only contract codes select user-facing explanations here. */
export function exploreIssue(error: unknown): ExploreIssue {
  switch (error instanceof KbApiError ? error.code : undefined) {
    case 'not_ready': return { message: 'Explore is not ready. Check Settings and try again.', settings: true };
    case 'consent_required': return { message: 'Science search needs your permission in Settings → Search.', settings: true };
    case 'openalex_daily_limit': return { message: 'OpenAlex daily limit reached. Add a key in Settings or retry after the limit resets.', settings: true };
    case 'provider_unavailable': return { message: 'The search provider is unavailable. Try again in a moment.' };
    case 'conflict': return { message: 'This job changed. Its saved state is being refreshed; try again from that state.' };
    default: return { message: 'Couldn’t complete this request. Try again.' };
  }
}
