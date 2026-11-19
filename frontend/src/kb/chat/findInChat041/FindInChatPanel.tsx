import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { FindInChatController } from './useFindInChat';
import './findInChat.css';

/** Mount beside the conversation scroller, within its chat stage. */
export function FindInChatPanel({ find }: { find: FindInChatController }) {
  if (!find.isOpen) return null;
  const count = find.matches.length;
  const position = find.activeIndex + 1;
  return (
    <div className="kb-find-chat" role="search" aria-label="Find in this chat">
      <Icon name="search" size={14} className="kb-find-chat__icon" />
      <input
        ref={find.inputRef}
        className="kb-find-chat__input"
        aria-label="Text to find in this chat"
        placeholder="Find in chat"
        value={find.query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          find.move(event.shiftKey ? -1 : 1);
        }}
      />
      <span className="kb-find-chat__count" role="status" aria-atomic="true">
        <span aria-hidden="true">{position} / {count}</span>
        <span className="kb-visually-hidden">
          {count ? `Match ${position} of ${count}` : find.query.trim() ? 'No matches' : ''}
        </span>
      </span>
      <IconButton icon="chevronUp" size="sm" label="Previous match" tooltip={false} disabled={!count} onClick={() => find.move(-1)} />
      <IconButton icon="chevronDown" size="sm" label="Next match" tooltip={false} disabled={!count} onClick={() => find.move(1)} />
      <IconButton icon="close" size="sm" label="Close chat search" tooltip={false} onClick={find.close} />
    </div>
  );
}
