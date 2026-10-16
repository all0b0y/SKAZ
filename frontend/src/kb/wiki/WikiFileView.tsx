import { useCallback } from 'react';
import { AnswerMarkdown, type InAppLink } from '../ui/AnswerMarkdown';
import { Banner, Button, EmptyState, Icon, Spinner } from '../ui';
import { useServices, useUi } from '../state/context';
import type { WikiFileName } from '../state/document';
import { PanelFrameButtons } from '../document/parts';
import { blockMarkdown, inAppTarget } from '../document/text';
import { useLoad } from '../document/useLoad';

const NO_CITES: never[] = [];
const TITLE: Record<WikiFileName, string> = { index: 'Index', log: 'Log' };
const NOTE: Record<WikiFileName, string> = {
  index: 'Every wiki page with a line about it. SKAZ keeps it up to date.',
  log: 'What happened in the wiki, newest last. SKAZ writes it.',
};

/**
 * `Wiki/index.md` / `Wiki/log.md` in the right panel, read-only (B20): SKAZ writes these files;
 * their links open pages and materials here. Rendered by the safe Markdown renderer (no raw HTML).
 */
export function WikiFileView({ name }: { name: WikiFileName }) {
  const { client } = useServices();
  const openDocument = useUi((s) => s.openDocument);
  const { state, reload } = useLoad(`wiki-file-${name}`, () => client.call('GET /kb/wiki/files/{name}', { path: { name } }));
  const inAppLink = useCallback<InAppLink>((href, label, key) => {
    const target = inAppTarget(href);
    if (!target) return null;
    return <button key={key} type="button" className="kb-wikilink" data-link={target.type} onClick={() => openDocument(target)}>{label}</button>;
  }, [openDocument]);
  const file = state.value;
  // The file's own first heading is the panel title already.
  const text = file ? file.text.replace(/^# [^\n]*\n+/, '') : '';
  return (
    <>
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type"><Icon name="text" size={14} /><span>Wiki {TITLE[name].toLowerCase()}</span></span>
        <span className="kb-head__spacer" />
        <PanelFrameButtons />
      </header>
      <div className="kb-doc__body">
        {state.load === 'loading' && !file && <div className="kb-doc__wait"><Spinner label={`Opening the ${TITLE[name].toLowerCase()}`} /></div>}
        {state.load === 'error' && !file && (
          <Banner tone="error" title={`Couldn’t open the ${TITLE[name].toLowerCase()}.`}
            actions={<Button size="sm" icon="retry" onClick={reload}>Try again</Button>}>{state.error}</Banner>
        )}
        {file && (
          <article className="kb-doc__article kb-page" data-wiki-file={name}>
            <h2 className="kb-doc__title">{TITLE[name]}</h2>
            <p className="kb-doc__meta">Read-only · {NOTE[name]}</p>
            {text.trim() ? (
              <div className="kb-md">
                <AnswerMarkdown content={blockMarkdown(text, file.links)} citations={NO_CITES} activeSessionId={null}
                  onCite={() => undefined} inAppLink={inAppLink} />
              </div>
            ) : (
              <EmptyState icon="wiki" title={name === 'index' ? 'No pages yet' : 'Nothing happened yet'} compact>
                {name === 'index' ? 'Pages appear here as materials are added to the wiki.' : 'Changes to the wiki are listed here.'}
              </EmptyState>
            )}
          </article>
        )}
      </div>
    </>
  );
}
