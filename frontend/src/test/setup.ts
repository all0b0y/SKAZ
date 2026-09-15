import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom has no media APIs; provide inert stubs so components that touch them on
// mount don't crash. Individual tests can override these.
if (!('mediaDevices' in navigator)) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(async () => {
        throw new Error('no media in test');
      }),
    },
  });
}

// A minimal preload bridge so the store's lazily-created client can exist.
if (!('audiohelper' in window)) {
  Object.defineProperty(window, 'audiohelper', {
    configurable: true,
    writable: true,
    value: {
      request: vi.fn(async () => ({ ok: true, status: 200, data: null })),
      uploadAudio: vi.fn(async () => ({ ok: true, status: 200, data: { duplicate: false, segments: [] } })),
      storeAudio: vi.fn(async () => ({ ok: true, status: 201, data: { sequence: 0, duplicate: false } })),
      fetchAudio: vi.fn(async () => ({ ok: true, status: 200, data: new ArrayBuffer(0) })),
      getBackendStatus: vi.fn(async () => ({ phase: 'ready' })),
      onBackendStatus: vi.fn(() => () => undefined),
      platform: 'test',
    },
  });
}
