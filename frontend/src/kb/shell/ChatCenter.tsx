import { EmptyState, Icon } from '../ui';

/**
 * Centre column: the chat area. U1 provides the frame only — header, an empty state and a
 * composer of fixed height with no logic (the chat itself is U2).
 */
export function ChatCenter({ hidden }: { hidden: boolean }) {
  return (
    <section className="kb-center" data-pane="center" aria-label="Chat" hidden={hidden}>
      <header className="kb-head">
        <h1 className="kb-head__title">New chat</h1>
      </header>
      <div className="kb-center__body">
        <EmptyState icon="chats" title="Ask about your materials">
          Answers will cite the exact moments of your recordings and the pages of your documents.
        </EmptyState>
      </div>
      <div className="kb-composer" aria-disabled="true" data-testid="composer">
        <label className="kb-visually-hidden" htmlFor="kb-composer-input">Message</label>
        <textarea
          id="kb-composer-input"
          className="kb-composer__input"
          rows={1}
          disabled
          placeholder="Ask about your materials · @ to reference"
        />
        <div className="kb-composer__bar">
          <span className="kb-composer__slot" aria-hidden="true"><Icon name="plus" size={16} /></span>
          <span className="kb-composer__spacer" />
          <span className="kb-composer__note">Chat isn’t connected yet</span>
          <span className="kb-composer__slot" aria-hidden="true"><Icon name="mic" size={16} /></span>
          <span className="kb-composer__send" aria-hidden="true"><Icon name="send" size={14} /></span>
        </div>
      </div>
    </section>
  );
}
