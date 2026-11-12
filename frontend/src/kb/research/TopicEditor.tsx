import { useEffect, useState } from 'react';
import type { KbAreaMap, KbResearchTopic } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button, Spinner } from '../ui';

/** Include the uncommitted Add field: Start / Allow must never silently omit what was typed. */
export function topicDraft(topics: KbResearchTopic[], pending: string) {
  const finalTopics = topics.map((topic) => ({ ...topic, text: topic.text.trim(), area_id: topic.area_id ?? null }));
  if (pending.trim()) finalTopics.push({ text: pending.trim(), source: 'typed', area_id: null });
  const problem = finalTopics.length === 0 ? 'Add at least one topic to start.'
    : finalTopics.length > 4 ? 'Keep up to 4 topics.'
    : finalTopics.some((topic) => !topic.text) ? 'Enter a name for every topic or remove it.'
    : finalTopics.some((topic) => Array.from(topic.text).length > 72) ? 'Each topic can have up to 72 characters.'
    : new Set(finalTopics.map((topic) => topic.text.toLocaleLowerCase())).size !== finalTopics.length ? 'Remove duplicate topics.'
    : null;
  return { finalTopics, problem };
}

/** Shared by the proposal card and the agent's permission card; stored topic paths stay local. */
export function TopicEditor({ topics, onChange, pending, onPendingChange, disabled = false }: {
  topics: KbResearchTopic[];
  onChange: (topics: KbResearchTopic[]) => void;
  pending: string;
  onPendingChange: (text: string) => void;
  disabled?: boolean;
}) {
  const { client } = useServices();
  const [picker, setPicker] = useState(false);
  const [parent, setParent] = useState<string | null>(null);
  const [map, setMap] = useState<KbAreaMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const { finalTopics, problem } = topicDraft(topics, pending);
  useEffect(() => {
    if (!picker) return;
    let live = true;
    setLoading(true); setError(null); setMap(null);
    void client.call('GET /kb/explore/map', { query: { parent_id: parent } }).then((value) => {
      if (live) { setMap(value); setLoading(false); }
    }, (e: unknown) => { if (live) { setError(errorText(e)); setLoading(false); } });
    return () => { live = false; };
  }, [client, picker, parent, retry]);
  const add = () => {
    if (!pending.trim() || problem) return;
    onChange(finalTopics); onPendingChange('');
  };
  return (
    <section className="kb-research-topics" aria-label="Research topics">
      <p className="kb-research-perm__meta">Keep, edit or remove proposed topics, type your own, or pick from your wiki. Choose 1–4 topics.</p>
      <ul className="kb-research-topics__list" aria-label="Topics that will be searched">
        {topics.map((topic, i) => <li key={i}>
          <input aria-label={`Topic ${i + 1}`} value={topic.text} disabled={disabled}
            onChange={(e) => onChange(topics.map((value, index) => index !== i ? value : {
              ...value, text: e.target.value,
              ...(value.source === 'picked' ? { source: 'typed' as const, area_id: null } : {}),
            }))} />
          <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onChange(topics.filter((_, index) => index !== i))}>
            <span className="kb-visually-hidden">Remove topic {i + 1}</span><span aria-hidden="true">Remove</span>
          </Button>
        </li>)}
      </ul>
      <div className="kb-research-topics__add">
        <input aria-label="Add your own topic" placeholder="Your topic…" value={pending} disabled={disabled}
          onChange={(e) => onPendingChange(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }} />
        <Button size="sm" disabled={disabled || !pending.trim() || Boolean(problem)} onClick={add}>Add topic</Button>
        <Button size="sm" disabled={disabled} onClick={() => setPicker((v) => !v)} aria-expanded={picker}>Pick from your topics</Button>
      </div>
      {picker && <div className="kb-research-topics__picker" role="group" aria-label="Your wiki topics">
        <input type="search" aria-label="Find a topic" placeholder="Find a topic…" value={query} onChange={(e) => setQuery(e.target.value)} disabled={disabled} />
        {parent && <Button size="sm" onClick={() => { setParent(map?.breadcrumbs.at(-2)?.id ?? null); setQuery(''); }} disabled={disabled}>Back to topics</Button>}
        {loading && <Spinner label="Loading topics" size="sm" />}
        {error && <><p role="alert" className="kb-inline-error">Topics couldn’t be loaded. {error}</p><Button size="sm" onClick={() => setRetry((v) => v + 1)}>Try again</Button></>}
        {map && <ul className="kb-research-topics__list">
          {map.areas.filter((area) => area.level === 'custom' && area.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((area) => <li key={area.id}>
            <Button size="sm" aria-label={`Pick ${area.name}`} disabled={disabled || topics.length >= 4}
              onClick={() => { onChange([...topics, { text: area.name, source: 'picked', area_id: area.id }]); setPicker(false); }}>{area.name}</Button>
            <Button size="sm" variant="quiet" aria-label={`Open subtopics of ${area.name}`} disabled={disabled}
              onClick={() => { setParent(area.id); setQuery(''); }}>Subtopics</Button>
          </li>)}
          {map.areas.length === 0 && <li>{parent ? 'No subtopics here.' : 'No wiki topics yet. You can type your own.'}</li>}
        </ul>}
      </div>}
      <p className="kb-research-topics__preview">Will search: {finalTopics.map((topic) => topic.text).filter(Boolean).join(' · ') || 'Choose topics first'}</p>
      {problem && <p className="kb-research-perm__meta" role="status">{problem}</p>}
    </section>
  );
}
