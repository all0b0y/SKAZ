// The finding view (F3, N4 v4 states 09–14): what the paper is, what it means for the wiki, what text the
// wiki would get, and the actions (Explore, Add to wiki, read marks). It is hosted in the Explore area
// column by F1; it owns its own loading and never reads another slice's tables.
import { useEffect, useRef, useState } from 'react';
import type { KbExploring, KbFinding, KbScienceSettings } from '../../../api/kb/types.gen';
import { errorText } from '../../api/client';
import { useServices } from '../../state/context';
import { getResearchStore } from '../../research/store';
import { Banner, Button, Chip, Icon, IconButton, Menu, Spinner, type MenuItem } from '../../ui';
import { useFindingClients } from './clients';
import {
  EXPLORE_MODES, LABEL_TEXT, MODE_LABEL, OPENALEX_HINT, READ_MARKS, READ_MARK_TEXT, addContent, addLabel, authorLine,
  freeCopy, hintShown, paidText, publisherUrl, showsAddToWiki, sourceLine, type ExploreMode, type ReadMarkValue,
} from './labels';
import './finding.css';

export interface FindingDetailProps {
  /** The finding to show (its id from the findings list). */
  findingId: string;
  /** "← New": back to the list. */
  onClose: () => void;
}

type Busy = 'explore' | 'add' | 'mark' | null;

export function FindingDetail({ findingId, onClose }: FindingDetailProps) {
  const { explore, areas, science } = useFindingClients();
  const { chats, ui, prefs, client } = useServices();

  const [finding, setFinding] = useState<KbFinding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<KbScienceSettings | null>(null);
  const [exploring, setExploring] = useState<KbExploring | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    setFinding(null);
    setLoadError(null);
    setActionError(null);
    setNote(null);
    explore.finding(findingId).then(
      (f) => { if (live) setFinding(f); },
      (e: unknown) => { if (live) setLoadError(errorText(e)); },
    );
    return () => { live = false; };
  }, [explore, findingId]);

  // The hint and the "already exploring" line are extras: when they cannot be read they are simply not shown.
  useEffect(() => {
    let live = true;
    science.settings().then((s) => { if (live) setSettings(s); }, () => undefined);
    return () => { live = false; };
  }, [science]);

  useEffect(() => {
    let live = true;
    setExploring(null);
    explore.exploring().then(
      (list) => { if (live) setExploring(list.items.find((item) => item.finding_id === findingId) ?? null); },
      () => undefined,
    );
    return () => { live = false; };
  }, [explore, findingId]);

  if (loadError !== null) {
    return (
      <section className="kb-finding">
        <div><Button variant="quiet" size="sm" icon="chevronLeft" onClick={onClose}>New</Button></div>
        <Banner tone="error" title="This finding can’t be opened">{loadError}</Banner>
      </section>
    );
  }
  if (finding === null) {
    return <section className="kb-finding"><Spinner label="Loading finding" /></section>;
  }

  const { work } = finding;
  const paid = work.access.paid;
  const free = paid ? freeCopy(work.access) : null;
  const publisher = publisherUrl(work);
  const meta = [authorLine(work), work.publication.year, work.venue].filter(Boolean).join(' · ');
  const extraTheses = finding.theses.filter((t) => t.text !== finding.reason);
  // One row of wiki pages: the finding's own refs and each thesis's, a page listed once.
  const wikiRefs = [...finding.wiki_refs, ...finding.theses.flatMap((t) => t.wiki_refs)]
    .filter((ref, i, all) => all.findIndex((r) => r.page_id === ref.page_id) === i);

  const openPage = (page: { page_id: string; block_id?: string | null }) =>
    ui.getState().openDocument({ type: 'page', id: page.page_id, block_id: page.block_id ?? null });

  const openChat = (chatId: string) => {
    getResearchStore(client).getState().close();
    prefs.getState().set({ section: 'chats', sideOpen: true });
    if (ui.getState().docExpanded) ui.getState().toggleDocExpanded();
    ui.getState().showCenter('chat');
    void chats.getState().open(chatId);
  };

  const startExplore = async (mode: ExploreMode) => {
    setBusy('explore');
    setActionError(null);
    try {
      const started = await explore.explore(finding.id, { mode });
      setExploring(started);
      openChat(started.chat_id);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const addToWiki = async () => {
    setBusy('add');
    setActionError(null);
    try {
      const imported = await explore.add_to_wiki(finding.id, { content: addContent(finding) });
      setNote(imported.content === 'full_text'
        ? 'Added to your wiki from the full text.'
        : 'Added to your wiki from the abstract only.');
      setFinding(await explore.finding(finding.id));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const setMark = async (value: ReadMarkValue) => {
    setBusy('mark');
    setActionError(null);
    try {
      const res = finding.read_mark === value
        ? await areas.remove_finding_mark(finding.id)
        : await areas.set_finding_mark(finding.id, { value });
      setFinding({ ...finding, read_mark: res.value });
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const dismissHint = async () => {
    setActionError(null);
    try {
      setSettings(await science.dismiss_hint());
    } catch (e) {
      setActionError(errorText(e));
    }
  };

  const menuItems: MenuItem[] = EXPLORE_MODES.map(({ mode, label }) => ({
    id: mode,
    label,
    onSelect: () => void startExplore(mode),
  }));

  return (
    <article className="kb-finding">
      <div><Button variant="quiet" size="sm" icon="chevronLeft" onClick={onClose}>New</Button></div>

      <h1 className="kb-finding__title">{work.title}</h1>
      {meta && <p className="kb-finding__meta">{meta}</p>}
      <p className="kb-finding__labels">
        <span className={finding.label === 'contradicts' ? 'kb-finding__signal' : 'kb-finding__label'}>
          {LABEL_TEXT[finding.label]}
        </span>
        {paid && <span className="kb-finding__badge">{free ? 'Free copy available' : 'Paid'}</span>}
      </p>

      <div className="kb-finding__source">
        <span>{sourceLine(finding.text_available)}</span>
        {publisher && (
          <a className="kb-link" href={publisher} target="_blank" rel="noreferrer noopener">
            Open on publisher site<Icon name="external" size={12} />
          </a>
        )}
      </div>

      {finding.reason && <p className="kb-finding__reason">{finding.reason}</p>}
      {extraTheses.length > 0 && (
        <ul className="kb-finding__theses">
          {extraTheses.map((thesis, i) => (
            <li key={i}>
              <p>{thesis.text}</p>
              {thesis.label !== finding.label && <p className="kb-finding__thesis-meta"><span>{LABEL_TEXT[thesis.label]}</span></p>}
            </li>
          ))}
        </ul>
      )}
      {wikiRefs.length > 0 && (
        <div className="kb-finding__refs">
          <span className="kb-finding__refs-label">In your wiki</span>
          {wikiRefs.map((ref) => (
            <Chip key={ref.page_id} kind="wiki" label={ref.title} onClick={() => openPage(ref)} />
          ))}
        </div>
      )}
      {finding.cites_materials.length > 0 && (
        <div className="kb-finding__refs">
          <span className="kb-finding__refs-label">From your materials</span>
          {finding.cites_materials.map((m) => (
            <Chip key={m.material_id} kind="document" label={m.title} onClick={() => ui.getState().openDoc(m.material_id)} />
          ))}
        </div>
      )}
      {finding.repeat_hint && <p className="kb-finding__muted">{finding.repeat_hint}</p>}

      {paid ? (
        <div className="kb-finding__paid">
          {free ? (
            <p>
              Free copy available.{' '}
              {free.url ? (
                <a className="kb-link" href={free.url} target="_blank" rel="noreferrer noopener">
                  {free.label}<Icon name="external" size={12} />
                </a>
              ) : (
                free.label
              )}
            </p>
          ) : (
            <p>{paidText(work.access)}</p>
          )}
          {work.access.alternatives_checked && work.access.free_alternative_ids.length === 0 && (
            <p className="kb-finding__muted">No free alternative found.</p>
          )}
        </div>
      ) : (
        work.abstract && (
          <>
            <h3 className="kb-finding__heading">Abstract</h3>
            <p className="kb-finding__abstract">{work.abstract}</p>
          </>
        )
      )}

      <div className="kb-finding__marks" role="group" aria-label="Your read mark">
        {READ_MARKS.map((value) => (
          <button
            key={value}
            type="button"
            className="kb-finding__mark"
            aria-pressed={finding.read_mark === value}
            disabled={busy === 'mark'}
            onClick={() => void setMark(value)}
          >
            {READ_MARK_TEXT[value]}
          </button>
        ))}
      </div>

      <div className="kb-finding__actions">
        <Button
          ref={anchorRef}
          variant="fill"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          busy={busy === 'explore'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          Explore<Icon name="chevronDown" size={14} />
        </Button>
        {showsAddToWiki(finding) && (
          <Button variant="outline" busy={busy === 'add'} onClick={() => void addToWiki()}>
            {addLabel(addContent(finding))}
          </Button>
        )}
      </div>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={anchorRef}
        label="Explore this finding"
        items={menuItems}
        placement="bottom-start"
      />

      {exploring && (
        <p className="kb-finding__exploring">
          <span>{`Exploring · ${MODE_LABEL[exploring.mode]}`}</span>
          <Button variant="quiet" size="sm" onClick={() => openChat(exploring.chat_id)}>Open chat</Button>
        </p>
      )}
      {note && <p className="kb-finding__note" role="status">{note}</p>}
      {finding.material_id && !note && <p className="kb-finding__muted">In your materials.</p>}
      {actionError && <Banner tone="error" title="That didn’t work">{actionError}</Banner>}

      {hintShown(finding, settings) && (
        <div className="kb-finding__hint">
          <p>{OPENALEX_HINT}</p>
          <Button variant="quiet" size="sm" onClick={() => ui.getState().openSettings('search')}>Add key in Settings</Button>
          <IconButton icon="close" label="Dismiss OpenAlex hint" size="sm" tooltip={false} onClick={() => void dismissHint()} />
        </div>
      )}
    </article>
  );
}
