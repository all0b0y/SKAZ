import { describe, expect, it } from 'vitest';
import { requestTimeoutMs, validateBridgeRequest } from '../../../electron/ipcPolicy';

describe('long Notes IPC', () => {
  it('allows editing a full-size note without enlarging unrelated request budgets', () => {
    const body = { content: 'Подробное объяснение. '.repeat(8000), expected_revision: 1 };
    expect(validateBridgeRequest({ method: 'PATCH', path: '/sessions/s/notes/n', body })).toBeNull();
    expect(validateBridgeRequest({ method: 'PUT', path: '/settings', body })).toMatch(/too large/);
    expect(validateBridgeRequest({ method: 'PATCH', path: '/sessions/s/notes/n',
      body: { content: 'x'.repeat(1_300_001) } })).toMatch(/too large/);
  });

  it('gives multi-pass generation time without extending ordinary requests', () => {
    expect(requestTimeoutMs({ method: 'POST', path: '/sessions/s/notes' })).toBe(3_600_000);
    expect(requestTimeoutMs({ method: 'POST', path: '/sessions/s/notes/n/rewrite' })).toBe(3_600_000);
    for (const request of [
      { method: 'GET', path: '/sessions/s/notes' },
      { method: 'POST', path: '/sessions/s/notes/empty' },
      { method: 'POST', path: '/sessions/s/notes/n/rewrite/apply' },
      { method: 'POST', path: '/codex/sessions/s/notes' },
    ]) expect(requestTimeoutMs(request)).toBe(120_000);
  });
});
