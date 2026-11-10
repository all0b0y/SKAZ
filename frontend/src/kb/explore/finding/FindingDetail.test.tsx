// The finding view in the area column (F3): every state of N4 v4 states 09–14 that it renders, on the fake
// client's scenes. The fake answers contract shapes; the real routes are the backend's to prove.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbApiError } from '../../api/client';
import { createFakeKb, type FakeKb } from '../../api/fake';
import { contractFixtures as f } from '../../api/fake/fixtures';
import { scenes, type SceneName } from '../../api/fake/scenes';
import type { KbFinding, KbReadMark, KbReadMarkUpdate, KbScienceSettings } from '../../../api/kb/types.gen';
import { createFakeBridge } from '../../test/fakeBridge';
import { createServices, KbServicesProvider } from '../../state/context';
import { MotionProvider } from '../../ui';
import { FindingClientsProvider } from './clients';
import { FindingDetail } from './FindingDetail';

afterEach(() => cleanup());

interface Mounted {
  fake: FakeKb;
  services: ReturnType<typeof createServices>;
  onClose: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
}

function mount(scene: SceneName | undefined, findingId: string, edit?: (fake: FakeKb) => void): Mounted {
  const fake = createFakeKb(scene);
  edit?.(fake);
  const services = createServices(createFakeBridge().bridge, null, { capture: null });
  const onClose = vi.fn();
  render(
    <KbServicesProvider services={services}>
      <MotionProvider>
        <FindingClientsProvider clients={{ explore: fake.explore, areas: fake.areas, science: fake.science }}>
          <FindingDetail findingId={findingId} onClose={onClose} />
        </FindingClientsProvider>
      </MotionProvider>
    </KbServicesProvider>,
  );
  return { fake, services, onClose, user: userEvent.setup() };
}

const PAID_RECOMMENDATION = scenes.paid.finding!.work.access.recommendation;

describe('paid article (v4 state 14)', () => {
  it('shows the title, the Paid badge and the approved copy, and a publisher link instead of Add to wiki', async () => {
    mount('paid', 'finding-paid');

    expect(await screen.findByRole('heading', { name: 'Tracing claims through changing sources' })).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText(PAID_RECOMMENDATION as string)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open on publisher site/ })).toHaveAttribute('href', 'https://example.org/publisher');
    expect(screen.queryByRole('button', { name: /Add to wiki/ })).toBeNull();
    expect(screen.queryByText(/buy/i)).toBeNull();
  });

  it('uses the approved copy when the server sends no recommendation', async () => {
    mount('paid', 'finding-paid', (fake) => {
      fake.explore.finding = async () => {
        const f0 = structuredClone(scenes.paid.finding!);
        f0.work.access = { ...f0.work.access, recommendation: null };
        return f0;
      };
    });

    expect(await screen.findByText(/This article is paid\. I think it's useful because … You can check it yourself/)).toBeInTheDocument();
  });
});

describe('paid article with a free copy (user decision B1-3 A)', () => {
  it.each([
    ['arxiv:2401.00001v2', 'https://arxiv.org/abs/2401.00001v2', /Open the free copy on arXiv/],
    ['doi:10.1000/pre', 'https://doi.org/10.1000/pre', /Open the free preprint/],
    ['https://repo.example.org/paper', 'https://repo.example.org/paper', /Open the free copy/],
  ])('shows "Free copy available" and links %s instead of the paid copy', async (id, href, name) => {
    mount('paid', 'finding-paid', (fake) => {
      fake.explore.finding = async () => {
        const f0 = structuredClone(scenes.paid.finding!);
        f0.work.access = { ...f0.work.access, alternatives_checked: true, free_alternative_ids: [id] };
        return f0;
      };
    });
    expect(await screen.findByText('Free copy available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    expect(screen.queryByText(PAID_RECOMMENDATION as string)).toBeNull();
    expect(screen.queryByText(/This article is paid/)).toBeNull();
  });

  it('says the text is free through OpenAlex when there is no page to open', async () => {
    mount('paid', 'finding-paid', (fake) => {
      fake.explore.finding = async () => {
        const f0 = structuredClone(scenes.paid.finding!);
        f0.work.access = { ...f0.work.access, alternatives_checked: true, free_alternative_ids: ['openalex-tei:W1'] };
        return f0;
      };
    });
    expect(await screen.findByText(/The full text is free through OpenAlex/)).toBeInTheDocument();
  });
});

describe('abstract only (v4 state 13)', () => {
  it('names the text boundary and adds the abstract, labelled as such', async () => {
    const { user } = mount('abstract_only', 'finding-abstract', (fake) => {
      fake.explore.add_to_wiki = async () => ({ ...structuredClone(f.KbFindingImported), content: 'abstract_only' });
    });

    expect(await screen.findByText('Abstract only · full text is PDF or paywalled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to wiki · abstract only' }));

    await waitFor(() => expect(screen.getByText('Added to your wiki from the abstract only.')).toBeInTheDocument());
  });

  it('calls add_to_wiki with the abstract content', async () => {
    const add = vi.fn(async () => ({ ...structuredClone(f.KbFindingImported), content: 'abstract_only' as const }));
    const { user } = mount('abstract_only', 'finding-abstract', (fake) => { fake.explore.add_to_wiki = add; });

    await user.click(await screen.findByRole('button', { name: 'Add to wiki · abstract only' }));
    expect(add).toHaveBeenCalledWith('finding-abstract', { content: 'abstract_only' });
  });

  it('shows the one-time OpenAlex key hint, and Add key in Settings opens Settings → Search', async () => {
    const { services, user } = mount('abstract_only', 'finding-abstract');
    const openSettings = vi.spyOn(services.ui.getState(), 'openSettings');

    expect(await screen.findByText('Add a free OpenAlex key to get full text for articles like this one.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add key in Settings' }));
    expect(openSettings).toHaveBeenCalledWith('search');
  });

  it('hides the hint for good once dismissed', async () => {
    const dismiss = vi.fn(async (): Promise<KbScienceSettings> => ({ ...f.KbScienceSettings, full_text_hint_dismissed: true }));
    const { user } = mount('abstract_only', 'finding-abstract', (fake) => { fake.science.dismiss_hint = dismiss; });

    await user.click(await screen.findByRole('button', { name: 'Dismiss OpenAlex hint' }));
    await waitFor(() => expect(screen.queryByText(/Add a free OpenAlex key/)).toBeNull());
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not show the hint when a key is already configured', async () => {
    mount('abstract_only', 'finding-abstract', (fake) => {
      fake.science.settings = async () => ({ ...f.KbScienceSettings, openalex_key_configured: true });
    });

    expect(await screen.findByRole('button', { name: 'Add to wiki · abstract only' })).toBeInTheDocument();
    expect(screen.queryByText(/Add a free OpenAlex key/)).toBeNull();
  });
});

describe('full text, contradicts your wiki (v4 state 12)', () => {
  it('signals the contradiction, shows Full text and adds the full text', async () => {
    const add = vi.fn(async () => ({ ...structuredClone(f.KbFindingImported), content: 'full_text' as const }));
    const { user } = mount('contradicts', 'finding-contradicts', (fake) => {
      fake.explore.add_to_wiki = add;
      // Before the add the finding has no material; the re-read after it has one.
      const first = structuredClone(scenes.contradicts.finding!);
      fake.explore.finding = vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValue({ ...structuredClone(first), material_id: 'material-1' });
    });

    expect(await screen.findByText('Contradicts your wiki')).toHaveClass('kb-finding__signal');
    expect(screen.getByText('Full text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add key in Settings/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add to wiki · full text' }));

    expect(add).toHaveBeenCalledWith('finding-contradicts', { content: 'full_text' });
    await waitFor(() => expect(screen.getByText('Added to your wiki from the full text.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Add to wiki/ })).toBeNull();
  });

  it('opens a wiki page it cites in the document panel', async () => {
    const { services, user } = mount('contradicts', 'finding-contradicts');
    const openDocument = vi.spyOn(services.ui.getState(), 'openDocument');

    await user.click(await screen.findByRole('button', { name: /Self-check loops/ }));
    expect(openDocument).toHaveBeenCalledWith({ type: 'page', id: 'page-self-check', block_id: null });
  });

  it('opens a material it relates to', async () => {
    const { services, user } = mount('contradicts', 'finding-contradicts');
    const openDoc = vi.spyOn(services.ui.getState(), 'openDoc');

    await user.click(await screen.findByRole('button', { name: /Reflexion/ }));
    expect(openDoc).toHaveBeenCalledWith('material-reflexion');
  });

  it('sets a read mark, shows it pressed, and removes it on a second press', async () => {
    const set = vi.fn(async (_id: string, body: KbReadMarkUpdate): Promise<KbReadMark> => ({
      material_id: null, finding_id: 'finding-contradicts', value: body.value, updated_at: '2026-11-10T09:00:00Z',
    }));
    const remove = vi.fn(async (): Promise<KbReadMark> => ({
      material_id: null, finding_id: 'finding-contradicts', value: null, updated_at: '2026-11-10T09:01:00Z',
    }));
    const { user } = mount('contradicts', 'finding-contradicts', (f0) => {
      f0.areas.set_finding_mark = set;
      f0.areas.remove_finding_mark = remove;
    });

    const mark = await screen.findByRole('button', { name: 'Useful method' });
    expect(mark).toHaveAttribute('aria-pressed', 'false');
    await user.click(mark);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Useful method' })).toHaveAttribute('aria-pressed', 'true'));
    expect(set).toHaveBeenCalledWith('finding-contradicts', { value: 'useful_method' });

    await user.click(screen.getByRole('button', { name: 'Useful method' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Useful method' })).toHaveAttribute('aria-pressed', 'false'));
    expect(remove).toHaveBeenCalledWith('finding-contradicts');
  });
});

describe('other labels (v4 states 09–10 finding rows)', () => {
  it('names an extension of the wiki, with the abstract hint', async () => {
    mount('extends', 'finding-extends');
    expect(await screen.findByText('Extends your wiki')).toBeInTheDocument();
    expect(screen.getByText('Abstract only · full text is PDF or paywalled')).toBeInTheDocument();
  });

  it('names a branch from the wiki', async () => {
    mount('branch', 'finding-branch');
    expect(await screen.findByText('Branch from your wiki')).toBeInTheDocument();
  });

  it('names a covered finding as already in the wiki', async () => {
    mount('covered', 'finding-covered');
    expect(await screen.findByText('Already in your wiki')).toBeInTheDocument();
  });
});

describe('Explore (menu of Brief tour, Deep dive, Notes)', () => {
  it('starts the chosen mode and opens its chat', async () => {
    const explore = vi.fn(async (_id: string, body: { mode: string }) => ({
      ...structuredClone(f.KbExploring), finding_id: 'finding-contradicts', mode: body.mode as 'deep_dive', chat_id: 'chat-deep',
    }));
    const { services, user } = mount('contradicts', 'finding-contradicts', (f0) => { f0.explore.explore = explore; });
    const open = vi.spyOn(services.chats.getState(), 'open').mockImplementation(() => undefined);
    const showCenter = vi.spyOn(services.ui.getState(), 'showCenter');

    await user.click(await screen.findByRole('button', { name: /Explore/ }));
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toEqual(['Brief tour', 'Deep dive', 'Notes']);
    await user.click(screen.getByRole('menuitem', { name: 'Deep dive' }));

    await waitFor(() => expect(explore).toHaveBeenCalledWith('finding-contradicts', { mode: 'deep_dive' }));
    expect(open).toHaveBeenCalledWith('chat-deep');
    expect(showCenter).toHaveBeenCalledWith('chat');
  });

  it('shows a finding that is already being explored, and opens its chat', async () => {
    const { services, user } = mount('contradicts', 'finding-contradicts', (fake) => {
      fake.explore.exploring = async () => ({
        items: [{ ...structuredClone(f.KbExploring), finding_id: 'finding-contradicts', mode: 'notes', chat_id: 'chat-notes' }],
      });
    });
    const open = vi.spyOn(services.chats.getState(), 'open').mockImplementation(() => undefined);

    expect(await screen.findByText('Exploring · Notes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(open).toHaveBeenCalledWith('chat-notes');
  });
});

describe('navigation and failures', () => {
  it('shows a loading line first, then the finding', async () => {
    mount('contradicts', 'finding-contradicts');
    expect(screen.getByText('Loading finding')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Self-correction in LLMs/ })).toBeInTheDocument();
  });

  it('goes back to New with onClose', async () => {
    const { onClose, user } = mount('contradicts', 'finding-contradicts');
    await user.click(await screen.findByRole('button', { name: 'New' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says why a finding cannot be opened, in the server words', async () => {
    mount(undefined, 'finding-gone', (fake) => {
      fake.explore.finding = async (): Promise<KbFinding> => { throw new KbApiError(404, 'This finding is gone.'); };
    });
    expect(await screen.findByText('This finding is gone.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
