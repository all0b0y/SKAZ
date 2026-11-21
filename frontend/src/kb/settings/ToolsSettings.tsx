import { useEffect, useId, useState, type ReactNode } from 'react';
import type { KbExternalItem, KbToolsSettings } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices, useSettings } from '../state/context';
import { Button, Icon } from '../ui';
import { ToolSourceDialog } from './ToolSourceDialog';
import { ToolTabs, type ToolKind } from './ToolTabs';
import './tools.css';

export function ToolsSettings({ humanizerDetails }: { humanizerDetails: ReactNode }) {
  const { client, settings } = useServices();
  const humanizer = useSettings(s => s.skills.value?.skills.find(x => x.id === 'humanizer'));
  const [data, setData] = useState<KbToolsSettings | null>(null);
  const [kind, setKind] = useState<ToolKind>('mcp');
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const prefix = useId();
  const mcp = kind === 'mcp';
  const group = mcp ? 'mcp' : 'skills';

  useEffect(() => {
    let live = true;
    client.call('GET /kb/settings/tools').then(value => { if (live) setData(value); },
      e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [client]);

  function update(item: KbExternalItem, remove = false) {
    const key = item.kind === 'mcp' ? 'mcp' : 'skills';
    setData(previous => {
      if (!previous) return previous;
      const list = previous[key];
      const next = remove ? list.filter(x => x.id !== item.id)
        : list.map(x => x.id === item.id ? { ...x, active: item.active } : x);
      return { ...previous, [key]: next };
    });
  }

  async function change(item: KbExternalItem, remove = false) {
    setBusy(item.id); setError('');
    try {
      if (remove) {
        await client.call('DELETE /kb/settings/tools/{item_id}', { path: { item_id: item.id } });
        update(item, true);
      } else if (item.built_in && item.id === 'humanizer') {
        const res = await settings.getState().setSkillEnabled(item.id, !item.active);
        if (!res.ok) throw new Error(res.error);
        update({ ...item, active: !item.active });
      } else {
        update(await client.call('PATCH /kb/settings/tools/{item_id}', { path: { item_id: item.id }, body: { active: !item.active } }));
      }
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }

  async function refreshTools(id: string) {
    if (refreshing.includes(id)) return;
    setRefreshing(current => [...current, id]);
    setError('');
    try {
      const refreshed = await client.call('POST /kb/settings/tools/{item_id}/refresh', { path: { item_id: id } });
      setData(current => current && {
        ...current,
        mcp: current.mcp.map(item => item.id === id ? { ...item, tools: refreshed.tools } : item),
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(current => current.filter(itemId => itemId !== id));
    }
  }
  return <div className="kb-tools">
    <p className="kb-sintro">One setup for Codex, Claude Code, Hermes and OpenCode.</p>
    <ToolTabs kind={kind} select={setKind} counts={[data?.mcp.length ?? 0, data?.skills.length ?? 0]} prefix={prefix} />
    <section role="tabpanel" id={prefix + 'panel'} aria-labelledby={prefix + kind}>
      <header className="kb-tools-heading"><div><h4>{mcp ? 'Connections' : 'Installed skills'}</h4>
        <p>{mcp ? 'Apps your agent can work with.' : 'Instructions your agent can use for a task.'}</p></div>
        <Button size="sm" onClick={() => setAdding(true)}>{mcp ? 'Add MCP' : 'Add skill'}</Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading tools…</p>}
      {data && !data[group].length && <div className="kb-tools-empty"><b>{mcp ? 'No connections yet' : 'No skills installed'}</b>
        <p>{mcp ? 'Add an MCP server to see its tools here.' : 'Add a skill to use its instructions.'}</p></div>}
      {data?.[group].map(record => {
        const item = record.built_in && humanizer ? { ...record, active: humanizer.enabled } : record;
        const open = expanded.includes(item.id), tools = item.tools ?? [];
        const loadingTools = refreshing.includes(item.id);
        return <div key={item.id} className="kb-tools-entry" role="group" aria-label={item.name}>
          <div className="kb-tools-row"><Icon name={mcp ? 'link' : 'skills'} size={21} />
            <div className="kb-tools-name"><strong>{item.name}</strong><div>{mcp ? item.recipient
              : item.built_in ? 'Built in · Ordinary chat replies' : [item.publisher, item.version].filter(Boolean).join(' · ')}
              {' · '}<button type="button" aria-expanded={open} onClick={() => {
                setExpanded(old => open ? old.filter(id => id !== item.id) : [...old, item.id]);
                if (!open && mcp && item.active) void refreshTools(item.id);
              }}>
                {mcp ? tools.length + (tools.length === 1 ? ' tool' : ' tools') : 'Details'}</button></div></div>
            <button type="button" className="kb-tools-toggle" role="switch" aria-label={item.name} aria-checked={item.active}
              disabled={!!busy} onClick={() => void change(item)}>{item.active ? 'Active' : 'Inactive'}<i aria-hidden="true" /></button>
          </div>
          {open && <div className="kb-tools-detail">
            {item.built_in ? humanizerDetails : <>
              <p>{item.warning || item.recipient || item.url}</p>
              {mcp && <ul>{tools.map(tool => <li key={tool.name}><b>{tool.name}</b> {tool.description}</li>)}</ul>}
              <div className="kb-tools-actions">
                {mcp && <Button size="sm" busy={loadingTools} disabled={!item.active || loadingTools}
                  onClick={() => void refreshTools(item.id)}>Refresh tools</Button>}
                <Button size="sm" disabled={!!busy} onClick={() => void change(item, true)}>{mcp ? 'Remove connection' : 'Remove skill'}</Button>
              </div>
            </>}
          </div>}
        </div>;
      })}
      <p className="kb-shint">{mcp ? 'Active connections still follow each chat’s permissions.' : 'Skills do not grant permissions or run bundled scripts.'}</p>
    </section>
    {adding && <ToolSourceDialog kind={kind} close={() => setAdding(false)} />}
  </div>;
}
