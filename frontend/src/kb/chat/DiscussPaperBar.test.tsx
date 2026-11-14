import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExploreClient } from '../api/explore';
import { DiscussPaperBar } from './DiscussPaperBar';

function fakeExplore(overrides: Partial<ExploreClient> = {}): ExploreClient {
  return {
    add_to_materials: vi.fn(async () => ({
      finding_id: 'finding-1',
      material_id: 'mat-42',
      content: 'full_text' as const,
      importing: false,
      to_wiki: false,
    })),
    ...overrides,
  } as unknown as ExploreClient;
}

describe('DiscussPaperBar (FX-3)', () => {
  it('shows card note and Add to materials button when paper is not in materials yet, then hides once added', async () => {
    const explore = fakeExplore();
    const onAdded = vi.fn();
    render(
      <DiscussPaperBar
        finding={{
          finding_id: 'finding-1',
          title: 'Mixture of Experts Scaling Laws',
          material_id: null,
          importing: false,
        }}
        explore={explore}
        onAdded={onAdded}
      />,
    );

    expect(screen.getByText('Mixture of Experts Scaling Laws')).toBeInTheDocument();
    expect(screen.getByText(/Discussing card:/i)).toBeInTheDocument();

    const addBtn = screen.getByRole('button', { name: 'Add to materials' });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(explore.add_to_materials).toHaveBeenCalledWith('finding-1');
      expect(onAdded).toHaveBeenCalledWith('mat-42');
    });

    expect(screen.queryByRole('region', { name: 'Discussed paper' })).not.toBeInTheDocument();
  });

  it('renders nothing when finding already has material_id (it is referenced via @ in the composer)', () => {
    render(
      <DiscussPaperBar
        finding={{
          finding_id: 'finding-2',
          title: 'Routing Experts',
          material_id: 'mat-99',
          importing: false,
        }}
      />,
    );

    expect(screen.queryByRole('region', { name: 'Discussed paper' })).not.toBeInTheDocument();
  });
});
