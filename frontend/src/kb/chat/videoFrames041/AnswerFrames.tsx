import { useEffect, useRef, useState } from 'react';
import type { KbAnswerFrame } from '../../../api/kb/types.gen';
import { formatTimecode } from '../../../lib/time';
import { errorText, KbApiError } from '../../api/client';
import { useServices } from '../../state/context';
import { Button } from '../../ui';

const EMPTY_FRAMES: readonly KbAnswerFrame[] = [];

/** One metadata request per visible chat or completed answer, independent of message streaming. */
export function useAnswerFrames(chatId: string | null, completedAnswerId: string | undefined): readonly KbAnswerFrame[] {
  const { client } = useServices();
  const [snapshot, setSnapshot] = useState<{ chatId: string; frames: KbAnswerFrame[] } | null>(null);
  useEffect(() => {
    if (!chatId || !completedAnswerId) return;
    let active = true;
    void client.call('GET /kb/chats/{chat_id}/answer-frames', { path: { chat_id: chatId } })
      .then((frames) => { if (active) setSnapshot({ chatId, frames }); })
      .catch(() => { if (active) setSnapshot(null); });
    return () => { active = false; };
  }, [client, chatId, completedAnswerId]);
  return snapshot && snapshot.chatId === chatId ? snapshot.frames : EMPTY_FRAMES;
}

export function AnswerFrames({ chatId, frames }: { chatId: string; frames: readonly KbAnswerFrame[] }) {
  if (!frames.length) return null;
  return (
    <div role="group" aria-label="Video frames from this answer">
      {frames.map((frame) => <PinFrame key={frame.frame_id} chatId={chatId} frame={frame} />)}
    </div>
  );
}

function PinFrame({ chatId, frame }: { chatId: string; frame: KbAnswerFrame }) {
  const { client } = useServices();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const time = `${formatTimecode(frame.timestamp_ms)}.${String(frame.timestamp_ms % 1000).padStart(3, '0')}`;
  const done = pinned || frame.pinned;

  async function pin() {
    if (locked.current || done || unavailable) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await client.call('POST /kb/chats/{chat_id}/messages/{message_id}/frames/{frame_id}/pin', {
        path: { chat_id: chatId, message_id: frame.message_id, frame_id: frame.frame_id },
      });
      setPinned(result.pinned);
    } catch (failure) {
      setError(errorText(failure));
      setUnavailable(failure instanceof KbApiError
        && (failure.code === 'FRAME_EXPIRED' || failure.code === 'FRAME_UNAVAILABLE'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="kb-msg__actions">
        <span className="kb-msg__note">{frame.label} · {time}</span>
        {done ? <span className="kb-msg__note" role="status">Frame pinned</span> : (
          <Button size="sm" variant="quiet" busy={busy} disabled={busy || unavailable}
            aria-label={`Pin frame at ${time} from ${frame.label}`} onClick={() => void pin()}>Pin frame</Button>
        )}
      </div>
      {error && <p className="kb-inline-error kb-inline-error--flat kb-msg__error" role="alert">{error}</p>}
    </div>
  );
}
