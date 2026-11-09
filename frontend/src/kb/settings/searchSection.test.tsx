import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeKb } from '../api/fake';
import type { ScienceClient } from '../api/science';
import type { MaintenanceClient } from '../api/maintenance';
import type { KbScienceEgress } from '../../api/kb/types.gen';
import { ROWS, searchRows } from './schema';
import {
  FakeKbProvider,
  OpenAlexKeyRow,
  ScienceJournalRow,
  ScienceSwitchRow,
  WeeklyCheckRow,
} from './SearchSection';

describe('Settings → Search schema registration (F4)', () => {
  it('registers science-enabled, openalex-key, science-journal and weekly-check in section search', () => {
    const science = ROWS.find((r) => r.id === 'science-enabled');
    expect(science).toMatchObject({
      section: 'search',
      group: 'Scientific sources',
      label: 'Scientific papers & preprints',
    });
    expect(science?.hint).toContain('Only topics, DOIs and IDs leave this computer');

    const key = ROWS.find((r) => r.id === 'openalex-key');
    expect(key).toMatchObject({
      section: 'search',
      group: 'Scientific sources',
      label: 'OpenAlex key',
    });

    const journal = ROWS.find((r) => r.id === 'science-journal');
    expect(journal).toMatchObject({
      section: 'search',
      group: 'Scientific sources',
      label: 'Requests journal',
    });

    const weekly = ROWS.find((r) => r.id === 'weekly-check');
    expect(weekly).toMatchObject({
      section: 'search',
      group: 'Weekly check',
      label: 'Weekly check',
    });
  });

  it('matches synonyms for search in Find a setting', () => {
    expect(searchRows('openalex').map((r) => r.id)).toEqual(
      expect.arrayContaining(['science-enabled', 'openalex-key']),
    );
    expect(searchRows('arxiv').map((r) => r.id)).toEqual(
      expect.arrayContaining(['science-enabled', 'science-journal']),
    );
    expect(searchRows('crossref').map((r) => r.id)).toEqual(
      expect.arrayContaining(['science-enabled', 'science-journal']),
    );
    expect(searchRows('journal').map((r) => r.id)).toEqual(
      expect.arrayContaining(['science-journal']),
    );
    expect(searchRows('egress').map((r) => r.id)).toEqual(
      expect.arrayContaining(['science-enabled', 'science-journal']),
    );
    expect(searchRows('weekly').map((r) => r.id)).toEqual(
      expect.arrayContaining(['weekly-check']),
    );
    expect(searchRows('retractions').map((r) => r.id)).toEqual(
      expect.arrayContaining(['weekly-check']),
    );
  });
});

describe('Science integration switch with explicit consent text (F4)', () => {
  it('shows enabled status and consent timestamp when enabled', async () => {
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
    };

    render(<ScienceSwitchRow label="Scientific papers & preprints" client={client} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading…');

    const toggle = await screen.findByRole('switch', { name: 'Scientific papers & preprints' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('turning off sends enabled: false directly', async () => {
    const user = userEvent.setup();
    const update_settings = vi.fn(async () => ({
      enabled: false,
      consent_at: null,
      openalex_key_configured: false,
      full_text_hint_dismissed: false,
    }));
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
      update_settings,
    };

    render(<ScienceSwitchRow label="Scientific papers & preprints" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Scientific papers & preprints' });
    await user.click(toggle);

    expect(update_settings).toHaveBeenCalledWith({ enabled: false });
    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument());
  });

  it('turning on opens explicit consent dialog and passes consent: topics_dois_ids', async () => {
    const user = userEvent.setup();
    const update_settings = vi.fn(async () => ({
      enabled: true,
      consent_at: '2026-11-09T12:00:00Z',
      openalex_key_configured: false,
      full_text_hint_dismissed: false,
    }));
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: false,
        consent_at: null,
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
      update_settings,
    };

    render(<ScienceSwitchRow label="Scientific papers & preprints" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Scientific papers & preprints' });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    // Confirmation modal with explicit consent text
    const dialog = await screen.findByRole('dialog', { name: /scientific search/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/topics, DOIs, and IDs only/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Never your notes, chats, or materials/i)).toBeInTheDocument();

    // Clicking Allow sends explicit consent
    const allowBtn = within(dialog).getByRole('button', { name: 'Allow' });
    await user.click(allowBtn);

    expect(update_settings).toHaveBeenCalledWith({
      enabled: true,
      consent: 'topics_dois_ids',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('cancelling consent dialog keeps switch off and does not call update_settings', async () => {
    const user = userEvent.setup();
    const update_settings = vi.fn();
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: false,
        consent_at: null,
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
      update_settings,
    };

    render(<ScienceSwitchRow label="Scientific papers & preprints" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Scientific papers & preprints' });
    await user.click(toggle);

    const dialog = await screen.findByRole('dialog', { name: /scientific search/i });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(update_settings).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();
  });

  it('shows error message if reading settings fails', async () => {
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => {
        throw new Error('Connection failed');
      }),
    };

    render(<ScienceSwitchRow label="Scientific papers & preprints" client={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t read/);
  });
});

describe('OpenAlex key field (F4)', () => {
  it('shows "No key" and "Add key…" when not configured', async () => {
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
    };

    render(<OpenAlexKeyRow label="OpenAlex key" client={client} />);
    expect(await screen.findByText('No key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add key…' })).toBeInTheDocument();
  });

  it('allows typing a key and saving it via set_key', async () => {
    const user = userEvent.setup();
    const set_key = vi.fn(async () => ({
      enabled: true,
      consent_at: '2026-11-09T10:00:00Z',
      openalex_key_configured: true,
      full_text_hint_dismissed: false,
    }));
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
      set_key,
    };

    render(<OpenAlexKeyRow label="OpenAlex key" client={client} />);
    await user.click(await screen.findByRole('button', { name: 'Add key…' }));

    const input = screen.getByPlaceholderText('Paste OpenAlex key');
    expect(input).toHaveAttribute('type', 'password');

    await user.type(input, 'sample-openalex-key-1234');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(set_key).toHaveBeenCalledWith({ key: 'sample-openalex-key-1234' });
    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('clicking Remove sends an empty key to delete it', async () => {
    const user = userEvent.setup();
    const set_key = vi.fn(async () => ({
      enabled: true,
      consent_at: '2026-11-09T10:00:00Z',
      openalex_key_configured: false,
      full_text_hint_dismissed: false,
    }));
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: true,
        full_text_hint_dismissed: false,
      })),
      set_key,
    };

    render(<OpenAlexKeyRow label="OpenAlex key" client={client} />);
    expect(await screen.findByText('Configured')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: 'Remove' });
    await user.click(removeBtn);

    expect(set_key).toHaveBeenCalledWith({ key: '' });
    expect(await screen.findByText('No key')).toBeInTheDocument();
  });

  it('Escape key cancels editing and restores previous view', async () => {
    const user = userEvent.setup();
    const client: ScienceClient = {
      ...createFakeKb().science,
      settings: vi.fn(async () => ({
        enabled: true,
        consent_at: '2026-11-09T10:00:00Z',
        openalex_key_configured: false,
        full_text_hint_dismissed: false,
      })),
    };

    render(<OpenAlexKeyRow label="OpenAlex key" client={client} />);
    await user.click(await screen.findByRole('button', { name: 'Add key…' }));
    expect(screen.getByPlaceholderText('Paste OpenAlex key')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('Paste OpenAlex key')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add key…' })).toBeInTheDocument();
  });
});

describe('Egress journal list (F4)', () => {
  it('opens modal on "Show…" and displays outgoing request records', async () => {
    const user = userEvent.setup();
    const records: KbScienceEgress[] = [
      {
        id: 'egress-1',
        requested_at: '2026-11-09T10:00:00Z',
        provider: 'openalex',
        operation: 'search',
        destination_host: 'api.openalex.org',
        payload: {
          topics: ['RAG', 'Grounding'],
          dois: [],
          ids: [],
        },
        outcome: 'succeeded',
        status_code: 200,
        run_id: 'run-1',
      },
      {
        id: 'egress-2',
        requested_at: '2026-11-09T10:05:00Z',
        provider: 'arxiv',
        operation: 'metadata',
        destination_host: 'export.arxiv.org',
        payload: {
          topics: [],
          dois: ['10.1234/test'],
          ids: [],
        },
        outcome: 'failed',
        status_code: 502,
        run_id: 'run-1',
      },
    ];
    const client: ScienceClient = {
      ...createFakeKb().science,
      journal: vi.fn(async () => ({
        records,
        next_cursor: null,
      })),
    };

    render(<ScienceJournalRow client={client} />);
    const showBtn = screen.getByRole('button', { name: 'Show…' });
    await user.click(showBtn);

    const dialog = await screen.findByRole('dialog', { name: /requests journal/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Only topics, DOIs and IDs leave this computer/)).toBeInTheDocument();

    // Verify record contents
    expect(within(dialog).getByText(/openalex · search/i)).toBeInTheDocument();
    expect(within(dialog).getByText('api.openalex.org')).toBeInTheDocument();
    expect(within(dialog).getByText(/succeeded · 200/)).toBeInTheDocument();
    expect(within(dialog).getByText(/RAG, Grounding/)).toBeInTheDocument();

    expect(within(dialog).getByText(/arxiv · metadata/i)).toBeInTheDocument();
    expect(within(dialog).getByText('export.arxiv.org')).toBeInTheDocument();
    expect(within(dialog).getByText(/failed · 502/)).toBeInTheDocument();
    expect(within(dialog).getByText(/10.1234\/test/)).toBeInTheDocument();

    // Done closes modal
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows empty message when journal has no records', async () => {
    const user = userEvent.setup();
    const client: ScienceClient = {
      ...createFakeKb().science,
      journal: vi.fn(async () => ({ records: [], next_cursor: null })),
    };

    render(<ScienceJournalRow client={client} />);
    await user.click(screen.getByRole('button', { name: 'Show…' }));

    const dialog = await screen.findByRole('dialog', { name: /requests journal/i });
    expect(await within(dialog).findByText('No requests recorded yet.')).toBeInTheDocument();
  });
});

describe('Weekly check switch with last/next run (F4)', () => {
  it('renders switch, last run and next run when enabled', async () => {
    const client: MaintenanceClient = {
      ...createFakeKb().maintenance,
      settings: vi.fn(async () => ({
        enabled: true,
        last_completed_at: '2026-11-09T10:00:00Z',
        next_due_at: '2026-11-16T10:00:00Z',
        missed: false,
        latest_check_id: 'check-1',
        candidates_waiting: 14,
      })),
    };

    render(<WeeklyCheckRow label="Weekly check" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Weekly check' });
    expect(toggle).toBeChecked();

    expect(screen.getByText(/Last:/)).toBeInTheDocument();
    expect(screen.getByText(/Next:/)).toBeInTheDocument();
    expect(screen.getByText(/14 waiting/)).toBeInTheDocument();
  });

  it('shows missed status when missed is true', async () => {
    const client: MaintenanceClient = {
      ...createFakeKb().maintenance,
      settings: vi.fn(async () => ({
        enabled: true,
        last_completed_at: null,
        next_due_at: '2026-11-01T10:00:00Z',
        missed: true,
        latest_check_id: null,
        candidates_waiting: 0,
      })),
    };

    render(<WeeklyCheckRow label="Weekly check" client={client} />);
    await screen.findByRole('switch', { name: 'Weekly check' });
    expect(screen.getByText(/missed/i)).toBeInTheDocument();
  });

  it('shows Off when disabled', async () => {
    const client: MaintenanceClient = {
      ...createFakeKb().maintenance,
      settings: vi.fn(async () => ({
        enabled: false,
        last_completed_at: null,
        next_due_at: null,
        missed: false,
        latest_check_id: null,
        candidates_waiting: 0,
      })),
    };

    render(<WeeklyCheckRow label="Weekly check" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Weekly check' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('toggling switch calls update_settings', async () => {
    const user = userEvent.setup();
    const update_settings = vi.fn(async ({ enabled }: { enabled: boolean }) => ({
      enabled,
      last_completed_at: null,
      next_due_at: '2026-11-16T10:00:00Z',
      missed: false,
      latest_check_id: null,
      candidates_waiting: 0,
    }));
    const client: MaintenanceClient = {
      ...createFakeKb().maintenance,
      settings: vi.fn(async () => ({
        enabled: false,
        last_completed_at: null,
        next_due_at: null,
        missed: false,
        latest_check_id: null,
        candidates_waiting: 0,
      })),
      update_settings,
    };

    render(<WeeklyCheckRow label="Weekly check" client={client} />);
    const toggle = await screen.findByRole('switch', { name: 'Weekly check' });
    await user.click(toggle);

    expect(update_settings).toHaveBeenCalledWith({ enabled: true });
    await waitFor(() => expect(toggle).toBeChecked());
  });
});

describe('FakeKbProvider integration with scene (F4)', () => {
  it('renders with weekly_done scene from createFakeKb', async () => {
    const fake = createFakeKb('weekly_done');
    render(
      <FakeKbProvider fake={fake}>
        <WeeklyCheckRow label="Weekly check" />
      </FakeKbProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Weekly check' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/14 waiting/)).toBeInTheDocument();
  });
});
