import { describe, expect, it } from 'vitest';
import { KbApiError, KbClient } from './client';

describe('KbClient failures', () => {
  it('keeps the backend error_code next to the plain-English detail (W-3 web_page_unavailable)', async () => {
    const detail = 'This page needs a sign-in or blocks automatic access. Save the page as PDF and import it.';
    const client = new KbClient({
      request: async () => ({ ok: false as const, status: 422, detail, code: 'web_page_unavailable' }),
    });
    const error = await client.call('POST /kb/materials/web', { body: { url: 'https://example.com/a' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KbApiError);
    expect(error).toMatchObject({ status: 422, detail, code: 'web_page_unavailable' });
  });

  it('has no code when the backend sends none', async () => {
    const client = new KbClient({ request: async () => ({ ok: false as const, status: 404, detail: 'Material not found.' }) });
    const error = await client.material('m1').catch((e: unknown) => e);
    expect((error as KbApiError).code).toBeUndefined();
  });
});
