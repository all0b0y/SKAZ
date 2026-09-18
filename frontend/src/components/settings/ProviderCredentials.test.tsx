import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderCredentials } from './ProviderCredentials';

describe('ProviderCredentials — a key belongs to the provider', () => {
  it('reports each keystroke against the provider, not against a task', async () => {
    const onChangeKey = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        hasStoredKey={false}
        draftKey={undefined}
        onChangeKey={onChangeKey}
      />,
    );

    await user.type(screen.getByLabelText('API key'), 'a');

    expect(onChangeKey).toHaveBeenLastCalledWith('openrouter', 'a');
  });

  it('never reports a key before the user types anything', () => {
    const onChangeKey = vi.fn();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        hasStoredKey
        draftKey={undefined}
        onChangeKey={onChangeKey}
      />,
    );
    expect(onChangeKey).not.toHaveBeenCalled();
  });

  it('offers a key field for a provider no task uses yet, and says so plainly', () => {
    render(
      <ProviderCredentials
        provider="anthropic"
        tasks={[]}
        hasStoredKey={false}
        draftKey={undefined}
        onChangeKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByText(/not assigned to any task yet/i)).toBeInTheDocument();
  });

  it('names the tasks that share this provider key', () => {
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent', 'notes']}
        hasStoredKey={false}
        draftKey={undefined}
        onChangeKey={vi.fn()}
      />,
    );
    expect(screen.getByText(/used by assistant, notes/i)).toBeInTheDocument();
  });

  it('claims a stored key only when the backend actually holds one', () => {
    const { rerender } = render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        hasStoredKey={false}
        draftKey={undefined}
        onChangeKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'Not set');
    expect(screen.queryByText(/key stored securely/i)).not.toBeInTheDocument();

    rerender(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        hasStoredKey
        draftKey={undefined}
        onChangeKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', '•••••••• stored');
    expect(screen.getByText(/key stored securely for openrouter/i)).toBeInTheDocument();
  });

  it('treats a cleared draft as a pending removal, not as a stored key', () => {
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        hasStoredKey
        draftKey=""
        onChangeKey={vi.fn()}
      />,
    );
    // The backend still holds a key, but this session is about to delete it.
    expect(screen.queryByText(/key stored securely/i)).not.toBeInTheDocument();
  });
});

describe('ProviderCredentials — show/hide', () => {
  it('reveals the typed key as plain text only after clicking Show', async () => {
    const user = userEvent.setup();
    render(
      <ProviderCredentials
        provider="openrouter"
        tasks={['agent']}
        hasStoredKey={false}
        draftKey="sk-draft"
        onChangeKey={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  });
});
