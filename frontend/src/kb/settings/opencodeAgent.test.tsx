import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { validateBridgeRequest } from '../../../../electron/ipcPolicy';
import { EngineBadge } from '../ui/EngineBadge';
import { ENGINE_NAME, ENGINE_ORDER } from '../state/agents';
import { ROWS } from './schema';

/** W-1: OpenCode is a fourth agent with its own mark, card rows and bridge routes. */
describe('OpenCode agent', () => {
  it('is listed after the other agents with its own name and colour mark', () => {
    expect(ENGINE_ORDER).toEqual(['codex', 'claude_code', 'hermes', 'opencode']);
    expect(ENGINE_NAME.opencode).toBe('OpenCode');
    render(<EngineBadge engine="opencode" label size={32} />);
    const mark = screen.getByRole('img', { name: 'OpenCode' });
    expect(mark).toHaveAttribute('data-engine', 'opencode');
    expect(mark.querySelector('img')?.getAttribute('src')).toContain('131010'); // the bundled OpenCode mark
  });

  it('has an agent card and a skills row in Settings', () => {
    const card = ROWS.find((r) => r.id === 'agent-opencode');
    expect(card).toMatchObject({ section: 'conn', group: 'Agent', label: 'OpenCode' });
    expect(ROWS.find((r) => r.id === 'skill-opencode')).toMatchObject({ section: 'skills', label: 'OpenCode' });
  });

  it('may be checked, installed and signed in to over the bridge — and nothing wider', () => {
    // Accounts & keys v3: OpenCode also signs out of SKAZ's own OpenCode folder.
    for (const action of ['check', 'install', 'login', 'logout']) {
      expect(validateBridgeRequest({ method: 'POST', path: `/kb/agents/opencode/${action}` })).toBeNull();
    }
    for (const [method, path] of [
      ['GET', '/kb/agents/opencode/login'],
      ['POST', '/kb/agents/opencode/providers'], ['POST', '/kb/agents/opencodex/login'],
    ] as const) {
      expect(validateBridgeRequest({ method, path }), `${method} ${path}`).not.toBeNull();
    }
  });
});
