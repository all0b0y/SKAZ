import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileEditor } from './ProfileEditor';
import { useStore } from '../../state/store';
import type {
  ModelInfo,
  Profile,
  ProfileUpdate,
  TaskKind,
} from '../../api/types';

// Deterministic per-provider catalogs. The frontend renders whatever the backend
// returns; these fixtures exercise search + honest labels only. output_modalities
// mirrors the backend CatalogModel field so the text picker can defend against a
// stale catalog that still lists non-text-output models.
const catalog = (provider: string): ModelInfo[] => {
  if (provider === 'openai') {
    return [
      { id: 'openai/gpt-4o', name: 'GPT-4o', input_modalities: ['text', 'image'], output_modalities: ['text'], verified: true },
      { id: 'openai/o3', name: 'O3', input_modalities: ['text'], output_modalities: ['text'], verified: false },
    ];
  }
  return [
    { id: 'anthropic/claude-3-5', name: 'Claude 3.5 Sonnet', input_modalities: ['text'], output_modalities: ['text'], verified: true },
    { id: 'meta/llama-3-70b', name: 'Llama 3 70B', input_modalities: ['text'], output_modalities: ['text'], verified: false },
    { id: 'openai/gpt-4', name: 'GPT-4', input_modalities: ['text'], output_modalities: ['text'], verified: true },
    { id: 'g/gemini-vision', name: 'Gemini Vision', input_modalities: ['text', 'image'], output_modalities: ['text', 'image'], verified: true },
    { id: 'bfl/flux', name: 'Flux Image', input_modalities: ['text'], output_modalities: ['image'], verified: true },
    { id: 'sd/sdxl', name: 'SDXL', input_modalities: ['text'], output_modalities: ['image'], verified: true },
  ];
};

const profileFor = (overrides: Partial<Profile> = {}): Profile => ({
  provider: 'openrouter',
  model: '',
  has_api_key: false,
  ...overrides,
});

// Local checkpoint download/delete management lives entirely in the Local
// models section now (see LocalModelsBrowser.test.tsx) — ProfileEditor only
// ever picks a provider + model id, it no longer renders that panel inline.
function Harness({
  task = 'agent',
  profile,
  onDraft,
}: {
  task?: TaskKind;
  profile: Profile;
  onDraft?: (update: ProfileUpdate) => void;
}) {
  const [draft, setDraft] = useState<ProfileUpdate>({});
  return (
    <ProfileEditor
      task={task}
      label="Assistant"
      description="Answers questions about the recording."
      profile={profile}
      draft={draft}
      onChange={(update) => {
        setDraft(update);
        onDraft?.(update);
      }}
    />
  );
}

beforeEach(() => {
  useStore.setState({ loadModels: vi.fn(async (provider: string) => catalog(provider)) });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Providers moved from a <select> to a tab strip; tabs are labelled by their
 * PROVIDER_LABELS display name (e.g. "OpenAI", not the raw id "openai"). */
const selectProviderTab = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('tab', { name: label }));
};

/** Models moved from a <select> to a listbox of role="option" rows; clicking
 * a row is the new equivalent of selectOptions on the old <select>. */
const selectModelOption = async (user: ReturnType<typeof userEvent.setup>, name: RegExp | string) => {
  await user.click(screen.getByRole('option', { name }));
};

describe('ProfileEditor provider switch', () => {
  // The key/base_url fields themselves moved to the Providers section
  // (see ProviderCredentials.test.tsx); this only covers what stays here —
  // switching provider must still reset the draft's model and clear any
  // stale api_key/base_url slot so a later Providers-section write never
  // lands under the wrong provider.
  it('resets model and clears the credential slots in the draft on provider switch', async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn();
    render(
      <Harness
        profile={profileFor({ provider: 'openai-compatible', base_url: 'https://old.example/v1', model: 'old-model' })}
        onDraft={onDraft}
      />,
    );
    await selectProviderTab(user, 'OpenAI');
    expect(onDraft).toHaveBeenLastCalledWith({ provider: 'openai', model: '', base_url: '', api_key: undefined });
  });
});

describe('ProfileEditor model search', () => {
  it('filters the catalog by a case-insensitive name query while keeping stored IDs intact', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} />);

    expect(await screen.findByRole('option', { name: /Llama 3 70B/ })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'CLAUDE');

    expect(screen.getByRole('option', { name: /Claude 3.5 Sonnet/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Llama 3 70B/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT-4/ })).not.toBeInTheDocument();
  });

  it('matches on the exact model ID case-insensitively', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.type(screen.getByRole('searchbox'), 'LLAMA-3-70B');

    expect(screen.getByRole('option', { name: /Llama 3 70B/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Claude 3.5 Sonnet/ })).not.toBeInTheDocument();
  });

  it('keeps the selected model visible even when the search query excludes it', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor({ model: 'openai/gpt-4' })} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.type(screen.getByRole('searchbox'), 'claude');

    // Selected model stays selectable so the user never silently loses it.
    expect(screen.getByRole('option', { name: /GPT-4/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude 3.5 Sonnet/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Llama 3 70B/ })).not.toBeInTheDocument();
  });

  it('indicates when no catalog model matches the query', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.type(screen.getByRole('searchbox'), 'zzzznomatch');

    expect(screen.getByText(/no models match/i)).toBeInTheDocument();
  });

  it('still shows the no-match indication while pinning the selected model', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor({ model: 'openai/gpt-4' })} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.type(screen.getByRole('searchbox'), 'zzzznomatch');

    // The stored selection stays visible, and the no-match hint is not masked by it.
    expect(screen.getByRole('option', { name: /GPT-4/ })).toBeInTheDocument();
    expect(screen.getByText(/no models match/i)).toBeInTheDocument();
  });

  it('reports the exact catalog ID on selection without normalising it', async () => {
    const onDraft = vi.fn();
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} onDraft={onDraft} />);

    await screen.findByRole('option', { name: /Claude 3.5 Sonnet/ });
    await selectModelOption(user, /Claude 3.5 Sonnet/);

    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-3-5' }));
  });

  it('resets the stale query and catalog when the provider changes', async () => {
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.type(screen.getByRole('searchbox'), 'claude');
    expect(screen.queryByRole('option', { name: /Llama 3 70B/ })).not.toBeInTheDocument();

    await selectProviderTab(user, 'OpenAI');

    expect(await screen.findByRole('option', { name: /GPT-4o/ })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    // The stale openrouter catalog is gone.
    expect(screen.queryByRole('option', { name: /Claude 3.5 Sonnet/ })).not.toBeInTheDocument();
  });

  it('ignores an out-of-order load from a superseded provider', async () => {
    const resolvers: Record<string, (list: ModelInfo[]) => void> = {};
    useStore.setState({
      loadModels: vi.fn(
        (provider: string) =>
          new Promise<ModelInfo[]>((resolve) => {
            resolvers[provider] = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<Harness profile={profileFor()} />);

    await selectProviderTab(user, 'OpenAI');

    // The newer provider resolves first, then the stale one resolves late.
    resolvers.openai!(catalog('openai'));
    expect(await screen.findByRole('option', { name: /GPT-4o/ })).toBeInTheDocument();
    resolvers.openrouter!(catalog('openrouter'));

    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /Llama 3 70B/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /GPT-4o/ })).toBeInTheDocument();
  });
});

describe('ProfileEditor honest labels', () => {
  it.each(['empty', 'error'])('preserves the stored ID when the catalog is %s', async (kind) => {
    useStore.setState({ loadModels: vi.fn(async () => {
      if (kind === 'error') throw new Error('offline');
      return [];
    }) });
    render(<Harness profile={profileFor({ model: 'private/Exact-ID' })} />);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /private\/Exact-ID/ })).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('marks unverified and verified catalog models for text tasks', async () => {
    render(<Harness task="agent" profile={profileFor({ provider: 'openai' })} />);

    const unverified = await screen.findByRole('option', { name: /O3/ });
    expect(unverified).toHaveTextContent('Unverified');
    expect(screen.getByRole('option', { name: /GPT-4o/ })).toHaveTextContent('Verified');
  });

  it('warns when the selected text-task model is unverified', async () => {
    render(<Harness task="agent" profile={profileFor({ provider: 'openai', model: 'openai/o3' })} />);

    await screen.findByRole('option', { name: /O3/ });
    expect(screen.getByText(/not been verified/i)).toBeInTheDocument();
  });

  it('warns honestly when a custom model ID is entered', async () => {
    const onDraft = vi.fn();
    const user = userEvent.setup();
    render(<Harness task="agent" profile={profileFor()} onDraft={onDraft} />);

    await screen.findByRole('option', { name: /Llama 3 70B/ });
    await user.click(screen.getByRole('button', { name: /custom model id/i }));

    // Honest wording: not a categorical "never validated", but "not yet confirmed;
    // checked on save where the provider catalog supports it".
    expect(screen.getByText(/compatibility.*not yet confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/checks it.*when you save/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Model'), 'my/custom-model');
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({ model: 'my/custom-model' }));
  });
});

describe('ProfileEditor text-output filtering', () => {
  it('excludes explicit non-text-output models from a text picker while keeping multimodal text', async () => {
    render(<Harness task="agent" profile={profileFor()} />);

    // Multimodal text output is legitimate for a text task.
    expect(await screen.findByRole('option', { name: /Gemini Vision/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Llama 3 70B/ })).toBeInTheDocument();
    // Image-only output must never be offered for a text task.
    expect(screen.queryByRole('option', { name: /Flux Image/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /SDXL/ })).not.toBeInTheDocument();
  });

  it('shows a stored unsupported selection honestly without offering other incompatible entries', async () => {
    render(<Harness task="agent" profile={profileFor({ model: 'bfl/flux' })} />);

    // The stored selection is preserved and visible even though it is not text-output.
    expect(await screen.findByRole('option', { name: /Flux Image/ })).toBeDisabled();
    expect(screen.getByText(/does not list text output/i)).toBeInTheDocument();
    expect(screen.getByText(/incompatible with this task/i)).toBeInTheDocument();
    // Other incompatible catalog entries are still withheld.
    expect(screen.queryByRole('option', { name: /SDXL/ })).not.toBeInTheDocument();
  });

  it('does not text-filter the ASR picker', async () => {
    // ASR compatibility is about audio input, not text output; leave it to the ASR path.
    render(<Harness task="asr" profile={{ provider: 'openrouter', model: '', has_api_key: false }} />);
    expect(await screen.findByRole('option', { name: /Gemini Vision/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Flux Image/ })).toBeInTheDocument();
  });
});

// Contract: .runtime/asr-local-contract.md. Local checkpoint download/delete
// preparation itself is now covered by LocalModelsBrowser.test.tsx — this file
// only needs to prove ProfileEditor never triggers it (custom id -> no catalog
// entry -> no status check).
describe('ProfileEditor never touches local model preparation on its own', () => {
  it('never checks status or shows preparation UI for a custom (non-catalog) model id', async () => {
    const localModelStatus = vi.fn();
    useStore.setState({
      loadModels: vi.fn(async () => [
        { id: 'small', name: 'Whisper Small', input_modalities: ['audio'], output_modalities: ['text'], verified: true },
      ]),
      localModelStatus,
      prepareLocalModel: vi.fn(),
    });

    render(<Harness task="asr" profile={{ provider: 'local-whisper', model: 'my-custom-checkpoint', has_api_key: false }} />);

    // A non-catalog id is not a known checkpoint: the picker falls back to the
    // custom text input (no catalog options), which is the signal the catalog
    // has loaded. ProfileEditor never calls the local-model status/prepare APIs
    // itself — that lives entirely in the Local models section now.
    await screen.findByDisplayValue('my-custom-checkpoint');
    expect(localModelStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });
});

describe('ProfileEditor missing API key warning', () => {
  it('warns when a cloud provider has no saved or drafted key', () => {
    render(<Harness profile={profileFor({ provider: 'openrouter', has_api_key: false })} />);
    expect(screen.getByText(/No API key set for openrouter/i)).toBeInTheDocument();
  });

  it('does not warn once a key is already saved', () => {
    render(<Harness profile={profileFor({ provider: 'openrouter', has_api_key: true })} />);
    expect(screen.queryByText(/No API key set/i)).not.toBeInTheDocument();
  });

  it('never warns for a local provider, which needs no key', () => {
    render(
      <Harness
        task="asr"
        profile={profileFor({ provider: 'local-whisper', model: 'small', has_api_key: false })}
      />,
    );
    expect(screen.queryByText(/No API key set/i)).not.toBeInTheDocument();
  });
});
