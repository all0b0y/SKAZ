import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEditableText } from './InlineEditableText';

describe('InlineEditableText', () => {
  it('shows the value as static text until double-clicked', () => {
    render(<InlineEditableText value="Standup notes" onCommit={vi.fn()} className="name" />);
    expect(screen.getByText('Standup notes')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('enters edit mode on double-click and commits a new value on Enter', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEditableText value="Standup notes" onCommit={onCommit} className="name" />);

    await user.dblClick(screen.getByText('Standup notes'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Renamed session{Enter}');

    expect(onCommit).toHaveBeenCalledWith('Renamed session');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('commits on blur too', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <InlineEditableText value="Standup notes" onCommit={onCommit} className="name" />
        <button>elsewhere</button>
      </>,
    );

    await user.dblClick(screen.getByText('Standup notes'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Blurred name');
    await user.click(screen.getByText('elsewhere'));

    expect(onCommit).toHaveBeenCalledWith('Blurred name');
  });

  it('cancels on Escape without committing', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEditableText value="Standup notes" onCommit={onCommit} className="name" />);

    await user.dblClick(screen.getByText('Standup notes'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Discarded{Escape}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('Standup notes')).toBeInTheDocument();
  });

  it('does not commit an empty or unchanged value', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineEditableText value="Standup notes" onCommit={onCommit} className="name" />);

    await user.dblClick(screen.getByText('Standup notes'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, '   {Enter}');

    expect(onCommit).not.toHaveBeenCalled();
  });
});
