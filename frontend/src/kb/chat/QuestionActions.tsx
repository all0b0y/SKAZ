import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { KbMessageInput } from '../../api/kb/types.gen';
import { copyToClipboard } from '../../lib/clipboard';
import { Button, IconButton, type IconName } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { caretToEnd, fillEditor, insertText, serialize } from '../composer/editor';

/**
 * Your own message's actions (2026-10-21, chat-actions mock «Icons under it on hover»): Copy · Edit ·
 * Resend under the bubble, shown on hover and keyboard focus like Copy · Regenerate · Save under an
 * answer. Edit turns the bubble into a field in place; Resend asks the same question at the end.
 */
export interface QuestionActions {
  /** Why Edit and Resend wait (an answer is being written in this chat); null = they work now. */
  waitReason: string | null;
  /** Resolves null when the edited question went, else why not (the field stays open). */
  onEdit: (input: KbMessageInput) => Promise<string | null>;
  onResend: () => void;
  /** Why the last Resend didn't start, shown under the message. */
  error?: string | null;
}

export const EDIT_NOTE = 'Answers after this question are removed and it is answered again.';

/** An action that waits: still focusable, says why (aria-disabled + description), does nothing. */
function WaitingButton({ icon, label, reason, onClick }: { icon: IconName; label: string; reason: string | null; onClick: () => void }) {
  const id = useId();
  if (!reason) return <IconButton icon={icon} label={label} size="sm" onClick={onClick} />;
  return (
    <>
      <Tooltip text={reason}>
        <IconButton icon={icon} label={label} size="sm" tooltip={false} aria-disabled="true" aria-describedby={id}
          className="is-waiting" onClick={(e) => e.preventDefault()} />
      </Tooltip>
      <span id={id} className="kb-visually-hidden">{reason}</span>
    </>
  );
}

export function QuestionActionsRow({ text, actions, onEdit }: { text: string; actions: QuestionActions; onEdit: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="kb-msg__actions kb-msg__actions--user" role="group" aria-label="Message actions">
      <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} size="sm"
        onClick={async () => setCopied(await copyToClipboard(text))} />
      <WaitingButton icon="pencil" label="Edit" reason={actions.waitReason} onClick={onEdit} />
      <WaitingButton icon="retry" label="Resend" reason={actions.waitReason} onClick={actions.onResend} />
    </div>
  );
}

/**
 * The bubble as a field: the text with its mentions and quotes as tokens (they can be removed, not
 * retyped), attachments kept as they are. ↩ sends and ⇧↩ is a new line, as in the message field;
 * Esc cancels.
 */
export function QuestionEditor({ input, onSend, onCancel }: {
  input: KbMessageInput;
  onSend: (input: KbMessageInput) => Promise<string | null>;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [empty, setEmpty] = useState(!input.text.trim());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    fillEditor(root, input);
    root.focus({ preventScroll: true });
    caretToEnd(root);
    // Only when the field opens: later changes of the message must not overwrite what is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const root = ref.current;
    if (!root || sending) return;
    const value = serialize(root);
    if (!value.text.trim()) return;
    setSending(true);
    setError(null);
    const failed = await onSend({ ...value, attachments: input.attachments });
    if (!live.current) return;
    setSending(false);
    if (failed) setError(failed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="kb-msg__edit">
      <div ref={ref} className="kb-msg__editfield" contentEditable suppressContentEditableWarning role="textbox"
        aria-multiline="true" aria-label="Edit your question" tabIndex={0} onKeyDown={onKeyDown}
        onInput={() => setEmpty(!ref.current || !serialize(ref.current).text.trim())}
        onPaste={(event) => {
          // Only plain text comes in, as in the message field.
          event.preventDefault();
          if (ref.current) insertText(ref.current, event.clipboardData.getData('text/plain'));
          setEmpty(!ref.current || !serialize(ref.current).text.trim());
        }} />
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      <div className="kb-msg__editfoot">
        <small>{EDIT_NOTE}</small>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="fill" icon="send" busy={sending} disabled={empty} onClick={() => void send()}>Send</Button>
      </div>
    </div>
  );
}
