import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderCredentials } from './ProviderCredentials';
import type { Profile, ProfileUpdate, TaskKind } from '../../api/types';

const EMPTY_DRAFTS: Record<TaskKind, ProfileUpdate> = { asr: {}, agent: {}, notes: {} };

const profiles = (over: Partial<Record<TaskKind, Partial<Profile>>> = {}): Record<TaskKind, Profile> => ({
  asr: { provider: 'openrouter', model: 'asr-model', has_api_key: false, ...over.asr },
  agent: { provider: 'openrouter', model: 'agent-model', has_api_key: false, ...over.agent },
  notes: { provider: 'openrouter', model: 'notes-model', has_api_key: false, ...over.notes },
});

describe('ProviderCredentials — key collation across tasks', () => {
  it('applies one typed key to every listed task as the user types', async () => {
    const onApplyKey = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles()}
        drafts={EMPTY_DRAFTS}
        onApplyKey={onApplyKey}
        onChangeBaseUrl={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('API key'), 'sk-shared');

    // Every keystroke re-applies the full current value to both tasks — no
    // separate save step is needed for the common (non-conflicting) case.
    expect(onApplyKey).toHaveBeenLastCalledWith(['agent', 'notes'], 'sk-shared');
  });

  it('never calls onApplyKey before the user types anything (stays "untouched")', () => {
    const onApplyKey = vi.fn();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles({ agent: { has_api_key: true }, notes: { has_api_key: true } })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={onApplyKey}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(onApplyKey).not.toHaveBeenCalled();
  });

  it('shows a stored placeholder only when every profile using the provider already has a key', () => {
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles({ agent: { has_api_key: true }, notes: { has_api_key: true } })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', '•••••••• stored');
    expect(screen.getByText(/key stored securely for 2 profiles/i)).toBeInTheDocument();
  });

  it('is honest about differing stored-key state instead of collapsing it into one field', () => {
    const onApplyKey = vi.fn();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles({ agent: { has_api_key: true }, notes: { has_api_key: false } })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={onApplyKey}
        onChangeBaseUrl={vi.fn()}
      />,
    );

    // No silent single-key claim: the differing state is named per task.
    expect(screen.getByText(/stored keys differ across profiles using openrouter/i)).toBeInTheDocument();
    expect(screen.getByText(/assistant \(stored\)/i)).toBeInTheDocument();
    expect(screen.getByText(/notes \(not set\)/i)).toBeInTheDocument();
    // And nothing is written until the user explicitly applies a value.
    expect(onApplyKey).not.toHaveBeenCalled();
  });

  it('requires an explicit "apply to all" action before unifying a mismatched key', async () => {
    const onApplyKey = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles({ agent: { has_api_key: true }, notes: { has_api_key: false } })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={onApplyKey}
        onChangeBaseUrl={vi.fn()}
      />,
    );

    const applyButton = screen.getByRole('button', { name: /apply this key to all 2 profiles/i });
    expect(applyButton).toBeDisabled();

    await user.type(screen.getByLabelText('API key'), 'sk-unified');
    expect(onApplyKey).not.toHaveBeenCalled();

    await user.click(applyButton);
    expect(onApplyKey).toHaveBeenCalledWith(['agent', 'notes'], 'sk-unified');
  });

  it('never flags a mismatch for a task freshly switched into the provider this session', () => {
    // Only 'agent' was already saved under this provider; 'notes' just moved
    // here in the draft and has nothing stored yet — that is expected, not a
    // surprise disagreement from prior settings.
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        profiles={profiles({ agent: { has_api_key: true }, notes: { provider: 'openai' } })}
        drafts={{ ...EMPTY_DRAFTS, notes: { provider: 'openrouter' } }}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.queryByText(/differ/i)).not.toBeInTheDocument();
  });
});

describe('ProviderCredentials — local providers', () => {
  it('never shows a key field for a local provider', () => {
    render(
      <ProviderCredentials
        provider="local-whisper"
        tasks={['asr']}
        profiles={profiles()}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.getByText(/runs locally.*no api key required/i)).toBeInTheDocument();
  });
});

describe('ProviderCredentials — base URL', () => {
  it('only renders a base URL field for providers that need one', () => {
    const { rerender } = render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        profiles={profiles()}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();

    rerender(
      <ProviderCredentials
        provider="openai-compatible"
        tasks={['agent']}
        profiles={profiles({ agent: { provider: 'openai-compatible' } })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
  });

  it('applies a base URL edit to every listed task', async () => {
    const onChangeBaseUrl = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openai-compatible"
        tasks={['asr', 'agent']}
        profiles={profiles({
          asr: { provider: 'openai-compatible' },
          agent: { provider: 'openai-compatible' },
        })}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={onChangeBaseUrl}
      />,
    );
    await user.type(screen.getByLabelText('Base URL'), 'https://host/v1');
    expect(onChangeBaseUrl).toHaveBeenLastCalledWith(['asr', 'agent'], 'https://host/v1');
  });
});

describe('ProviderCredentials — show/hide', () => {
  it('reveals the typed key as plain text only after clicking Show', async () => {
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        profiles={profiles()}
        drafts={EMPTY_DRAFTS}
        onApplyKey={vi.fn()}
        onChangeBaseUrl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  });
});
