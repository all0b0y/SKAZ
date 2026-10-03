import { describe, expect, it } from 'vitest';
import type { CodexConnection } from '../../api/codex';
import { connectionBlockOf } from './codexLabels';

const base: CodexConnection = {
  status: 'incompatible', version: 'codex-cli 0.148.0', models: [], error: null,
  web_available: false, install_available: false, login: 'idle', path: '/u/.local/bin/codex',
  relogin_available: false,
} as CodexConnection;

describe('connectionBlockOf: incompatible Codex', () => {
  it('shows the backend reason (outdated, minimum version) instead of a generic label', () => {
    const block = connectionBlockOf({
      ...base, error: 'Codex 0.148.0 is outdated — version 0.149.1 or newer is required.',
    });
    expect(block).toEqual({
      text: 'Codex 0.148.0 is outdated — version 0.149.1 or newer is required.',
      fix: 'settings',
    });
  });

  it('shows a reply-format failure as its own reason', () => {
    const error = 'Codex 0.170.0 replied to model/list in an unexpected format; SKAZ cannot use this version.';
    expect(connectionBlockOf({ ...base, version: 'codex-cli 0.170.0', error })?.text).toBe(error);
  });

  it('falls back to the version when the backend gave no reason', () => {
    expect(connectionBlockOf({ ...base, error: null })?.text)
      .toBe('The installed Codex version codex-cli 0.148.0 cannot be used.');
  });
});
