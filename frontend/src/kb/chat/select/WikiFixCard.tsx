import { useState } from 'react';
import type { KbWikiFixPart } from '../../../api/kb/types.gen';
import { errorText } from '../../api/client';
import { Button, Icon } from '../../ui';
import { useServices } from '../../state/context';
import { pageRef, useOpenDocument } from '../../state/document';
import { useAnswerId } from './context';

/**
 * P2 decision 4: under an answer that rechecked items the user marked «That’s wrong» — the agent's
 * correction of a wiki block, before → after. The wiki changes only when the user presses «Fix in
 * wiki», as the user's own edit (the block becomes «edited by you»); a block that changed since is
 * left alone and the card says so. Look: answer-blocks-v3.html («Fix in wiki»).
 */
export function WikiFixCard({ chatId, part }: { chatId: string; part: KbWikiFixPart }) {
  const { client } = useServices();
  const messageId = useAnswerId();
  const open = useOpenDocument();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<KbWikiFixPart | null>(null);
  // The click's own answer shows at once; the chat's part_update brings the same.
  const fix = answered && part.status === 'proposed' ? answered : part;
  const apply = async () => {
    if (!messageId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswered(await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/wiki-fixes/{fix_id}/apply', {
        path: { chat_id: chatId, message_id: messageId, fix_id: part.id },
      }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const openPage = fix.available ? () => open(pageRef(fix.page, fix.block_id)) : undefined;
  return (
    <section className="kb-wikifix" aria-label={`Wiki fix: ${fix.page.title}`} data-status={fix.status}>
      <div className="kb-wikifix__head">
        <Icon name="concept" size={14} />
        {openPage ? (
          <button type="button" className="kb-wikifix__page" onClick={openPage}>Wiki · {fix.page.title}</button>
        ) : <span>Wiki · {fix.page.title}</span>}
      </div>
      {fix.reason && <p className="kb-wikifix__why">{fix.reason}</p>}
      <div className="kb-wikifix__diff" role="group" aria-label="Before and after">
        <div className="kb-wikifix__was"><span className="kb-wikifix__tag">Was</span><del>{fix.before}</del></div>
        <div className="kb-wikifix__now"><span className="kb-wikifix__tag">Now</span><ins>{fix.after}</ins></div>
      </div>
      <div className="kb-wikifix__foot">
        {fix.status === 'proposed' && fix.available && (
          <>
            <Button size="sm" variant="fill" icon="check" busy={busy} onClick={() => void apply()}>Fix in wiki</Button>
            <span className="kb-wikifix__note">Changes the wiki only when you click</span>
          </>
        )}
        {fix.status === 'proposed' && !fix.available && (
          <span className="kb-wikifix__note" role="note">The page is no longer in the wiki.</span>
        )}
        {fix.status === 'applied' && (
          <span className="kb-wikifix__done" role="status"><Icon name="check" size={14} />Fixed in wiki — edited by you</span>
        )}
        {fix.status === 'stale' && (
          <span className="kb-wikifix__note" role="status">
            <Icon name="warning" size={14} />The page changed since this was proposed — nothing was written.
          </span>
        )}
      </div>
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
    </section>
  );
}
