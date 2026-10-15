import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { KbMessageInput, KbQuote } from '../api/b2';
import { errorText } from '../api/client';
import { Icon, IconButton } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { agentOf } from '../state/agents';
import { isAnswering, type AgentChoice } from '../state/chats';
import { useAgents, useChats, useComposerBus, useLibrary, useServices, useSettings, useUi } from '../state/context';
import { AgentPicker, EffortPicker } from './AgentPicker';
import { addMaterial, attachmentKey, AttachButton, AttachmentChips, isSpeechFile, type Attachment } from './Attach';
import { DICTATION_MAX_S, startCapture, type Capture } from './dictation';
import { clearEditor, insertText, insertToken, isEmpty, mentionAtCaret, serialize, type MentionMatch } from './editor';
import { MentionPopup, useMentions, type MentionOption } from './MentionPopup';

type Dictation = { phase: 'idle' } | { phase: 'recording'; started: number } | { phase: 'transcribing' };

/** What the composer offers for a chat: its own agent, or the draft/default one for a new chat. */
export function useAgentChoice(chatId: string | null): AgentChoice | null {
  const chat = useChats((s) => (chatId ? s.list.find((c) => c.id === chatId) ?? s.chats[chatId]?.chat ?? null : null));
  const draft = useChats((s) => s.draftAgent);
  const agents = useAgents((s) => s.agents);
  return useMemo(() => {
    if (chat) return { engine: chat.engine, model: chat.model, effort: chat.effort };
    if (draft) return draft;
    if (!agents) return null;
    const a = agentOf(agents, agents.default);
    const model = a?.models.find((m) => m.id === a.current_model) ?? a?.models[0];
    return { engine: agents.default, model: model?.id ?? null, effort: model?.default_effort ?? null };
  }, [chat, draft, agents]);
}

/**
 * Message field (v3/v4/v21/v39): text with @-mention and quote tokens, "+" attachments, agent +
 * model + effort, dictation, send/stop. Height grows like text up to five lines, then scrolls.
 */
export function Composer({ chatId, placeholder }: { chatId: string | null; placeholder: string }) {
  const services = useServices();
  const { bridge, client, chats } = services;
  const editorRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [empty, setEmpty] = useState(true);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dictation, setDictation] = useState<Dictation>({ phase: 'idle' });
  const [hover, setHover] = useState<{ text: string; left: number; top: number } | null>(null);
  const captureRef = useRef<Capture | null>(null);

  const open = useChats((s) => (chatId ? s.chats[chatId]?.chat ?? null : null));
  const answering = isAnswering(open);
  const streaming = [...(open?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.state === 'streaming') ?? null;
  const choice = useAgentChoice(chatId);
  const agents = useAgents((s) => s.agents);
  const folders = useLibrary((s) => s.folders);
  const wiki = useSettings((s) => s.wiki.value);
  const speech = useSettings((s) => s.speech.value);
  const doc = useUi((s) => s.doc);
  const focusTick = useComposerBus((s) => s.focusTick);
  const queued = useComposerBus((s) => s.queue.length);
  const mentions = useMentions(mention ? mention.query : null);

  const agent = choice ? agentOf(agents, choice.engine) : undefined;
  const model = agent?.models.find((m) => m.id === choice?.model);
  const agentReady = agent?.state === 'ready';

  const refresh = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    setEmpty(isEmpty(root));
    const m = mentionAtCaret(root);
    setMention(m);
    if (!m) setActive(0);
  }, []);

  // Items handed over from elsewhere (selection toolbar, decisions, ⌘K).
  useEffect(() => {
    if (!queued) return;
    const root = editorRef.current;
    if (!root) return;
    const { items, send } = services.composer.getState().take();
    for (const item of items) {
      if (item.kind === 'quote') insertToken(root, { kind: 'quote', quote: item.quote });
      else if (item.kind === 'mention') insertToken(root, { kind: 'mention', ref: item.ref });
      else insertText(root, item.text);
    }
    refresh();
    if (send) void submit();
    // submit is stable enough for this hand-off; it reads current state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued]);

  useEffect(() => {
    if (focusTick) editorRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  useEffect(() => {
    // A new chat starts with an empty field and no attachments.
    if (editorRef.current) clearEditor(editorRef.current);
    setAttachments([]);
    setError(null);
    refresh();
  }, [chatId, refresh]);

  useEffect(() => () => captureRef.current?.cancel(), []);

  const pickMention = (option: MentionOption) => {
    const root = editorRef.current;
    if (!root) return;
    insertToken(root, { kind: 'mention', ref: option.ref }, mention);
    setMention(null);
    setActive(0);
    refresh();
    root.focus();
  };

  const inboxId = folders.find((f) => f.system)?.id ?? null;

  const addAttachments = (items: Array<{ source: Attachment['source']; name: string; value: string; materialId?: string }>) => {
    for (const item of items) {
      const key = attachmentKey();
      const inWiki = item.source === 'file' || item.source === 'link';
      setAttachments((list) => [...list, {
        key, name: item.name, source: item.source, state: item.materialId ? 'ready' : 'adding', materialId: item.materialId ?? null, error: null, inWiki,
      }]);
      if (item.materialId) continue;
      if (!inboxId) {
        setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'failed', error: 'Connect the library first.' } : a)));
        continue;
      }
      const source = item.source as 'file' | 'link' | 'text';
      addMaterial(client, source, item.value, inboxId).then(
        (id) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'ready', materialId: id } : a))),
        (e: unknown) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'failed', error: errorText(e) } : a))),
      );
    }
  };

  const autoWiki = (a: Attachment) => !!wiki && (a.source === 'text' ? wiki.auto_add_text : wiki.auto_add_files_links);

  const submit = async () => {
    const root = editorRef.current;
    if (!root || sending) return;
    const value = serialize(root);
    const ready = attachments.filter((a) => a.state === 'ready' && a.materialId);
    if (!value.text.trim() && !value.mentions.length && !value.quotes.length && !ready.length) return;
    if (attachments.some((a) => a.state === 'adding')) { setError('Wait until attachments are saved.'); return; }
    if (!agentReady) { setError(`${agent?.name ?? 'The agent'} can’t answer now${agent?.reason ? `: ${agent.reason}` : '.'}`); return; }
    if (answering) return;
    setSending(true);
    setError(null);
    const input: KbMessageInput = { text: value.text, mentions: value.mentions, quotes: value.quotes, attachments: ready.map((a) => a.materialId!) };
    const context = doc ? (doc.type === 'page' ? { open_page_id: doc.id } : { open_material_id: doc.id }) : {};
    const result = await chats.getState().send(input, context);
    setSending(false);
    if (!result.ok) { setError(result.error); return; }
    // "In wiki" for what Settings does not add by itself (decision 15).
    for (const a of ready) {
      if (a.source !== 'existing' && a.inWiki && !autoWiki(a)) {
        client.call('POST /kb/materials/{material_id}/ingest', { path: { material_id: a.materialId! } }).catch((e: unknown) => {
          setError(`“${a.name}” is saved to Materials but couldn’t go to the wiki yet: ${errorText(e)} You can add it from Materials later.`);
        });
      }
    }
    clearEditor(root);
    setAttachments([]);
    refresh();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mention && (mentions.options.length > 0)) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % mentions.options.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i - 1 + mentions.options.length) % mentions.options.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const option = mentions.options[Math.min(active, mentions.options.length - 1)];
        if (option) pickMention(option);
        return;
      }
    }
    if (mention && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Only plain text comes in: no foreign markup in the field.
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (editorRef.current) insertText(editorRef.current, text);
    refresh();
  };

  const toggleDictation = async () => {
    if (!bridge.dictate) return;
    if (dictation.phase === 'recording') {
      const capture = captureRef.current;
      captureRef.current = null;
      setDictation({ phase: 'transcribing' });
      try {
        const clip = await capture!.stop();
        const res = await bridge.dictate(clip.wav, speech?.languages[0]);
        if (!res.ok) throw new Error(res.detail);
        if (editorRef.current && res.data.text.trim()) {
          editorRef.current.focus();
          insertText(editorRef.current, res.data.text.trim());
          refresh();
        }
      } catch (e) {
        setError(`Dictation: ${errorText(e)}`);
      } finally {
        setDictation({ phase: 'idle' });
      }
      return;
    }
    if (dictation.phase !== 'idle') return;
    setError(null);
    try {
      captureRef.current = await startCapture();
      setDictation({ phase: 'recording', started: Date.now() });
    } catch (e) {
      setError(errorText(e));
    }
  };

  // The 2-minute limit stops dictation by itself.
  useEffect(() => {
    if (dictation.phase !== 'recording') return undefined;
    const timer = window.setTimeout(() => void toggleDictation(), DICTATION_MAX_S * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.phase]);

  const showHover = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.kb-token--quote');
    if (!el?.dataset.full) { setHover(null); return; }
    const r = el.getBoundingClientRect();
    setHover({ text: el.dataset.full, left: r.left, top: r.top });
  };

  const placeholderShown = empty && dictation.phase === 'idle';
  const popupOpen = mention !== null;
  const canSend = !empty || attachments.some((a) => a.state === 'ready');

  return (
    <div className="kb-composer" data-testid="composer">
      {popupOpen && (
        <MentionPopup id={listId} options={mentions.options} active={active} loading={mentions.loading} error={mentions.error}
          onPick={pickMention} onHover={setActive} />
      )}
      <AttachmentChips items={attachments} autoWiki={autoWiki}
        onToggleWiki={(key) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, inWiki: !a.inWiki } : a)))}
        onRemove={(key) => setAttachments((list) => list.filter((a) => a.key !== key))} />
      <div className="kb-editor-wrap">
        {placeholderShown && <span className="kb-editor__placeholder" aria-hidden="true">{placeholder}</span>}
        <div
          ref={editorRef}
          className="kb-editor"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          aria-placeholder={placeholder}
          aria-controls={popupOpen ? listId : undefined}
          aria-activedescendant={popupOpen && mentions.options.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          data-testid="message-input"
          onInput={refresh}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') refresh(); }}
          onMouseUp={refresh}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => window.setTimeout(() => setMention(null), 120)}
          onMouseOver={(e) => showHover(e.target)}
          onMouseLeave={() => setHover(null)}
        />
      </div>
      {hover && (
        <div className="kb-tooltip kb-tooltip--quote" role="tooltip" style={{ left: hover.left, top: Math.max(8, hover.top - 8), transform: 'translateY(-100%)' }}>
          {hover.text}
        </div>
      )}
      <div className="kb-composer__bar">
        <AttachButton onAdd={addAttachments} disabled={false} />
        <span className="kb-composer__spacer" />
        {dictation.phase === 'recording' && (
          <span className="kb-dictating" role="status"><span className="kb-dictating__dot" aria-hidden="true" />Listening</span>
        )}
        <AgentPicker choice={choice} existingChat={chatId !== null}
          onChoose={async (next) => {
            setError(null);
            const res = await chats.getState().setAgent(chatId, next);
            if (!res.ok) setError(res.error);
          }} />
        {choice && model && (
          <EffortPicker efforts={model.efforts} value={choice.effort}
            onChange={async (effort) => {
              const res = await chats.getState().setAgent(chatId, { ...choice, effort });
              if (!res.ok) setError(res.error);
            }} />
        )}
        {bridge.dictate ? (
          <IconButton icon="mic" label={dictation.phase === 'recording' ? 'Stop dictation' : dictation.phase === 'transcribing' ? 'Recognising…' : 'Dictate'}
            aria-pressed={dictation.phase === 'recording'} active={dictation.phase === 'recording'}
            className={dictation.phase === 'recording' ? 'kb-mic is-on' : 'kb-mic'}
            disabled={dictation.phase === 'transcribing'} onClick={() => void toggleDictation()} tooltipPlacement="top" />
        ) : (
          <Tooltip text="Dictation isn’t available in this window" placement="top" describes>
            <button type="button" className="kb-iconbtn kb-iconbtn--md" aria-label="Dictate" aria-disabled="true"><Icon name="mic" size={16} /></button>
          </Tooltip>
        )}
        {answering && streaming && chatId ? (
          <Tooltip text="Stop the answer" placement="top">
            <button type="button" className="kb-send is-stop" aria-label="Stop the answer"
              onClick={async () => { const r = await chats.getState().stop(chatId, streaming.id); if (!r.ok) setError(r.error); }}>
              <Icon name="stop" size={12} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip text={answering ? 'The agent is still answering' : 'Send (Enter)'} placement="top">
            <button type="button" className="kb-send" aria-label="Send" aria-disabled={!canSend || sending || answering || undefined}
              onClick={() => void submit()} data-busy={sending || undefined}>
              <Icon name="send" size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {error && <p className="kb-composer__error" role="alert">{error}</p>}
    </div>
  );
}

export type { KbQuote };
export { isSpeechFile };
