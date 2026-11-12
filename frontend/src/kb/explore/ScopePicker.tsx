import { useEffect, useRef, useState } from 'react';
import type { KbArea, KbPageHit } from '../../api/kb/types.gen';
import { Icon, Popover } from '../ui';
import { exploreIssue } from './errors';
import { loadTopicOptions, type TopicOption } from './topicTree';
import type { ExploreClients } from './types';

export function ScopePicker({ clients, value, onChange, onQuery, disabled = false }: {
  clients: ExploreClients; value: KbArea | null; onChange: (area: KbArea | null) => void;
  onQuery: (query: string) => void; disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<TopicOption[]>([]);
  const [concepts, setConcepts] = useState<KbPageHit[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const clean = query.trim();
  useEffect(() => {
    if (!open) return;
    let live = true; setLoading(true); setIssue(null); setOptions([]);
    void loadTopicOptions(clients.areas).then((next) => { if (live) setOptions(next); })
      .catch((error) => { if (live) setIssue(exploreIssue(error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [clients.areas, open, retry]);
  useEffect(() => {
    setConcepts([]);
    if (!open || !clean || !clients.discovery) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void clients.discovery!.concepts(clean).then((next) => { if (live) setConcepts(next); })
        .catch((error) => { if (live) setIssue(exploreIssue(error).message); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [clients.discovery, clean, open]);
  const close = () => { setOpen(false); anchor.current?.focus(); };
  const chooseQuery = (text: string) => { onQuery(text); close(); };
  return <>
    <button ref={anchor} type="button" className="kb-explore-search__scope" aria-label={`Search scope: ${value?.name ?? 'All your topics'}`}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => { setQuery(''); setOpen((old) => !old); }}>
      {value?.name ?? 'All your topics'}<Icon name="chevronDown" size={12} />
    </button>
    <Popover open={open} onClose={close} anchorRef={anchor} label="Choose search scope" className="kb-topic-picker" width={360}>
      <div className="kb-topic-picker__body">
        <input aria-label="Search topics or concepts" className="kb-explore-search__input" autoFocus value={query} placeholder="Search topics or concepts"
          onChange={(e) => setQuery(e.target.value)} />
        <div className="kb-explore-topic-list">
          <button type="button" className="kb-explore-item" onClick={() => { onChange(null); close(); }}>All your topics</button>
          {options.filter((option) => !clean || option.path.toLocaleLowerCase().includes(clean.toLocaleLowerCase())).map((option) =>
            <button key={option.area.id} type="button" className="kb-explore-item" onClick={() => { onChange(option.area); close(); }}>{option.path}</button>)}
          {loading && <p role="status" className="kb-explore-cap">Loading topics…</p>}
          {issue && <div role="alert" className="kb-explore-cap">{issue}<button type="button" className="kb-link" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>}
          {concepts.map((concept) => <button key={concept.id} type="button" className="kb-explore-item" aria-label={`Concept: ${concept.title}`}
            onClick={() => chooseQuery(concept.title)}>{concept.title}<span className="kb-explore-item__sub">Concept · use as a precise query</span></button>)}
          {clean && <button type="button" className="kb-explore-item" onClick={() => chooseQuery(clean)}>Search for “{clean}”{value ? ` in ${value.name}` : ''}</button>}
        </div>
      </div>
    </Popover>
  </>;
}
