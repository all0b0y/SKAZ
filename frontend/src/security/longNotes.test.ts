import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS, validateBridgeRequest } from '../../../electron/ipcPolicy';

describe('long Knowledge Wiki IPC', () => {
  it('accepts pasted sources without the ordinary settings body limit', () => {
    const body = { text: 'Подробное объяснение. '.repeat(80_000), title: 'Lecture' };
    expect(validateBridgeRequest({ method: 'POST', path: '/kb/materials/text', body })).toBeNull();
    expect(validateBridgeRequest({ method: 'PUT', path: '/settings', body })).toMatch(/too large/);
    expect(validateBridgeRequest({ method: 'POST', path: '/kb/materials/link', body })).toMatch(/too large/);
  });

  it('allows the full chat text budget including JSON escaping and metadata', () => {
    const body = { text: '\u0001'.repeat(100_000), model: 'chosen-model' };
    expect(validateBridgeRequest({ method: 'POST', path: '/kb/chats/c/messages', body })).toBeNull();
    expect(validateBridgeRequest({ method: 'PATCH', path: '/kb/chats/c', body })).toMatch(/too large/);
  });

  it('keeps a finite transport deadline; generation runs asynchronously', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(120_000);
  });
});
