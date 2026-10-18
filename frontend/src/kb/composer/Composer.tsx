import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useMentionDrop } from './MentionDrop';
import type { KbMessageInput, KbQuote } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Icon, IconButton } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { agentOf } from '../state/agents';
import { isAnswering, type AgentChoice } from '../state/chats';
import { partsOf } from '../api/permissions';
import { useAgents, useChats, useComposerBus, useLibrary, useRecording, useServices, useSettings, useUi } from '../state/context';
import { AgentPicker, EffortPicker } from './AgentPicker';
import { addMaterial, attachmentKey, AttachButton, AttachmentChips, isSpeechFile, type Attachment } from './Attach';
import { DICTATION_MAX_S, startCapture, type Capture } from './dictation';
import { clearEditor, insertText, insertToken, isEmpty, markGone, mentionAtCaret, serialize, type MentionMatch } from './editor';
import { MentionPopup, useMentions, type MentionOption } from './MentionPopup';
import { isLongPaste, PastedCard, pastedName } from './PastedText';
import { QuickQuestions } from './QuickQuestions';
import { openTarget } from '../state/document';
import { ingestWhenReady } from '../materials/ingestWhenReady';
import { AgentFix } from '../chat/AgentFix';

const NEW_CHAT = 'new';

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
  const drafts = services.composer.getState().drafts;
  const draftKey = useRef<string | null>(null);
  /** The chat a message is being sent from (its field must not be put aside as a draft). */
  const sendingFrom = useRef<string | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  /** The card of the paste just made: ⌘Z right after it puts the text into the field instead. */
  const lastPaste = useRef<string | null>(null);

  const open = useChats((s) => (chatId ? s.chats[chatId]?.chat ?? null : null));
  const answering = isAnswering(open);
  const streaming = [...(open?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.state === 'streaming') ?? null;
  // An agent question waits (Q-A2): the field stays free — a message of your own answers it instead.
  const questionWaits = !!streaming && partsOf(streaming).some((p) => p.type === 'question' && p.status === 'pending');
  const blocked = answering && !questionWaits;
  const choice = useAgentChoice(chatId);
  const agents = useAgents((s) => s.agents);
  const folders = useLibrary((s) => s.folders);
  const goneIds = useLibrary((s) => s.gone);
  const gone = useMemo(() => new Set(goneIds), [goneIds]);
  const wiki = useSettings((s) => s.wiki.value);
  const speech = useSettings((s) => s.speech.value);
  const doc = useUi(openTarget);
  const focusTick = useComposerBus((s) => s.focusTick);
  const queued = useComposerBus((s) => s.queue.length);
  const mentions = useMentions(mention ? mention.query : null);
  const recPhase = useRecording((s) => s.phase);
  const recId = useRecording((s) => s.materialId);
  const recTitle = useRecording((s) => s.title);

  const agent = choice ? agentOf(agents, choice.engine) : undefined;
  const model = agent?.models.find((m) => m.id === choice?.model);
  const agentReady = agent?.state === 'ready';
  const unavailable = `${agent?.name ?? 'The agent'} can’t answer now${agent?.reason ? `: ${agent.reason}` : '.'}`;
  /** The error is the agent's (not installed, signed out…): it comes with the way to fix it (QA D6). */
  const agentError = error === unavailable;

  const refresh = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    setEmpty(isEmpty(root));
    const m = mentionAtCaret(root);
    setMention(m);
    if (!m) setActive(0);
  }, []);

  useEffect(() => {
    if (focusTick) editorRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  useEffect(() => {
    // Each chat keeps its own unsent draft (QA D3/A22): leaving a chat puts its field aside, coming
    // back gives it back; another chat starts with its own draft or an empty field. A message that is
    // being sent moves with the chat it creates.
    const root = editorRef.current;
    const key = chatId ?? NEW_CHAT;
    const previous = draftKey.current;
    draftKey.current = key;
    lastPaste.current = null;
    setError(null);
    if (!root || previous === key) { refresh(); return; }
    if (previous !== null && previous === sendingFrom.current) {
      sendingFrom.current = key;
      refresh();
      return;
    }
    if (previous !== null) {
      if (!isEmpty(root) || attachmentsRef.current.length) {
        drafts.set(previous, { nodes: Array.from(root.childNodes), attachments: attachmentsRef.current });
      } else drafts.delete(previous);
    }
    clearEditor(root);
    const draft = drafts.get(key);
    drafts.delete(key);
    if (draft) root.replaceChildren(...draft.nodes);
    setAttachments(draft ? (draft.attachments as Attachment[]) : []);
    refresh();
  }, [chatId, refresh, drafts]);

  // Items handed over from elsewhere (selection toolbar, decisions). After the chat switch above, so
  // a hand-off that opens another chat lands in that chat's field (QA D2).
  useEffect(() => {
    if (!queued) return;
    const root = editorRef.current;
    if (!root) return;
    const items = services.composer.getState().take();
    for (const item of items) {
      if (item.kind === 'quote') insertToken(root, { kind: 'quote', quote: item.quote });
      else if (item.kind === 'mention') insertToken(root, { kind: 'mention', ref: item.ref });
      else insertText(root, item.text);
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued]);


  // A material deleted while it is referenced here (QA B8): its token is marked and its
  // attachment says so; neither can be sent.
  useEffect(() => {
    if (editorRef.current) markGone(editorRef.current, gone);
    setAttachments((list) => (list.some((a) => a.materialId && gone.has(a.materialId) && a.state !== 'failed')
      ? list.map((a) => (a.materialId && gone.has(a.materialId) ? { ...a, state: 'failed', error: 'This material was deleted.' } : a))
      : list));
  }, [gone, chatId]);

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
  // QA B7: a material made from an attachment is in Inbox at once — the Materials panel shows it.
  const saveMaterial = (source: 'file' | 'link' | 'text', value: string, folderId: string) =>
    addMaterial(client, source, value, folderId).then((added) => {
      void services.library.getState().loadContent();
      return added;
    });

  const addAttachments = (items: Array<{ source: Attachment['source']; name: string; value: string; materialId?: string }>) => {
    for (const item of items) {
      const key = attachmentKey();
      // Decision 15: the default comes from Settings → Wiki; the user may switch it either way.
      const inWiki = wiki ? (item.source === 'text' ? wiki.auto_add_text : wiki.auto_add_files_links) : item.source !== 'text';
      setAttachments((list) => [...list, {
        key, name: item.name, source: item.source, state: item.materialId ? 'ready' : 'adding', materialId: item.materialId ?? null, error: null, inWiki,
        materialReady: true,
      }]);
      if (item.materialId) continue;
      if (!inboxId) {
        setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'failed', error: 'Connect the library first.' } : a)));
        continue;
      }
      const source = item.source as 'file' | 'link' | 'text';
      saveMaterial(source, item.value, inboxId).then(
        (added) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'ready', materialId: added.id, materialReady: added.ready } : a))),
        (e: unknown) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'failed', error: errorText(e) } : a))),
      );
    }
  };

  const openContext = () => (doc ? (doc.type === 'page' ? { open_page_id: doc.id } : { open_material_id: doc.id }) : {});

  // Quick questions while recording: the recording goes along as an attached material, so the agent
  // reads its transcribed fragments only — never the words still being recognised.
  const quickReason = !agentReady ? unavailable : blocked ? 'The agent is still answering' : null;
  const askQuick = async (text: string) => {
    if (!recId || sending || quickReason) return;
    setSending(true);
    setError(null);
    const result = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [recId] }, openContext());
    setSending(false);
    if (!result.ok) setError(result.error);
  };
  const prefillQuick = (text: string) => {
    const root = editorRef.current;
    if (!root || !recId || quickReason) return;
    if (!attachments.some((a) => a.materialId === recId)) {
      addAttachments([{ source: 'existing', name: recTitle ?? 'Recording', value: recId, materialId: recId }]);
    }
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    lastPaste.current = null;
    insertText(root, text);
    refresh();
  };

  const submit = async () => {
    const root = editorRef.current;
    if (!root || sending) return;
    const value = serialize(root);
    // Long pastes are cards until now: they become pasted-text materials only with the message.
    const unsaved = attachments.filter((a) => a.text !== undefined && !a.materialId);
    if (!value.text.trim() && !value.mentions.length && !value.quotes.length && !unsaved.length
      && !attachments.some((a) => a.state === 'ready' && a.materialId)) return;
    if (attachments.some((a) => a.state === 'adding')) { setError('Wait until attachments are saved.'); return; }
    const deleted = [...markGone(root, gone), ...attachments.filter((a) => a.materialId && gone.has(a.materialId)).map((a) => a.name)];
    if (deleted.length) { setError(`“${deleted[0]}” was deleted. Remove it from the message to send.`); return; }
    if (!agentReady) { setError(unavailable); return; }
    if (blocked) return;
    setSending(true);
    setError(null);
    let list = attachments;
    if (unsaved.length) {
      if (!inboxId) { setSending(false); setError('Connect the library first.'); return; }
      lastPaste.current = null;
      const keys = new Set(unsaved.map((a) => a.key));
      setAttachments((now) => now.map((a) => (keys.has(a.key) ? { ...a, state: 'adding', error: null } : a)));
      const saved = await Promise.all(unsaved.map((a) => saveMaterial('text', a.text!, inboxId).then(
        (added) => ({ key: a.key, id: added.id as string | null, ready: added.ready, error: null as string | null }),
        (e: unknown) => ({ key: a.key, id: null, ready: false, error: errorText(e) }),
      )));
      const byKey = new Map(saved.map((r) => [r.key, r]));
      const settle = (a: Attachment): Attachment => {
        const r = byKey.get(a.key);
        if (!r) return a;
        return r.id ? { ...a, state: 'ready', materialId: r.id, materialReady: r.ready, error: null } : { ...a, state: 'failed', error: r.error };
      };
      list = list.map(settle);
      setAttachments((now) => now.map(settle));
      const failed = saved.find((r) => !r.id);
      if (failed) { setSending(false); setError(`The pasted text couldn’t be saved: ${failed.error}`); return; }
    }
    const ready = list.filter((a) => a.state === 'ready' && a.materialId);
    const input: KbMessageInput = { text: value.text, mentions: value.mentions, quotes: value.quotes, attachments: ready.map((a) => a.materialId!) };
    sendingFrom.current = draftKey.current;
    const result = await chats.getState().send(input, openContext());
    sendingFrom.current = null;
    setSending(false);
    if (!result.ok) { setError(result.error); return; }
    // "In wiki" (decision 15): new materials were held out of the wiki; the ticked ones go in now.
    for (const a of ready) {
      if (a.source !== 'existing' && a.inWiki) {
        ingestWhenReady(client, a.materialId!, a.materialReady, (text) => {
          setError(`“${a.name}” is saved to Materials but couldn’t go to the wiki yet: ${text} You can add it from Materials later.`);
        });
      }
    }
    clearEditor(root);
    setAttachments([]);
    lastPaste.current = null;
    refresh();
  };

  /** Put a pasted-text card back into the field as plain text. */
  const pasteAsText = (key: string) => {
    const root = editorRef.current;
    const card = attachments.find((a) => a.key === key);
    if (!root || card?.text === undefined) return;
    lastPaste.current = null;
    setAttachments((list) => list.filter((a) => a.key !== key));
    root.focus({ preventScroll: true });
    insertText(root, card.text);
    refresh();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (lastPaste.current && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      pasteAsText(lastPaste.current);
      return;
    }
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
    if (popupOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    // Only plain text comes in: no foreign markup in the field.
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (isLongPaste(text)) {
      // Too long for the field: a "Pasted text" card, like "+" → Paste text ("In wiki" off — decision 15).
      const key = attachmentKey();
      setAttachments((list) => [...list, {
        key, name: pastedName(text), source: 'text', state: 'ready', materialId: null, materialReady: true, error: null, inWiki: false, text,
      }]);
      lastPaste.current = key;
      return;
    }
    lastPaste.current = null;
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

  const mentionDrop = useMentionDrop();
  const placeholderShown = empty && dictation.phase === 'idle';
  // A query of several words stays a mention only while something matches; otherwise it is just text.
  const popupOpen = mention !== null && (!mention.query.includes(' ') || mentions.loading || mentions.options.length > 0);
  const canSend = !empty || attachments.some((a) => a.state === 'ready' || a.text !== undefined);

  return (
    <>
      {recPhase === 'recording' && recId && (
        <QuickQuestions disabledReason={quickReason} onAsk={(q) => void askQuick(q)} onPrefill={prefillQuick} />
      )}
      <div className="kb-composer" data-testid="composer" {...mentionDrop.handlers}>
        {mentionDrop.overlay}
        {popupOpen && (
          <MentionPopup id={listId} options={mentions.options} active={active} loading={mentions.loading} error={mentions.error}
            onPick={pickMention} onHover={setActive} />
        )}
        <AttachmentChips items={attachments}
          onToggleWiki={(key) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, inWiki: !a.inWiki } : a)))}
          onRemove={(key) => { if (lastPaste.current === key) lastPaste.current = null; setAttachments((list) => list.filter((a) => a.key !== key)); }}
          renderName={(a) => (a.text !== undefined ? <PastedCard attachment={a} text={a.text} onPasteAsText={() => pasteAsText(a.key)} /> : null)} />
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
            onInput={() => { lastPaste.current = null; refresh(); }}
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
          {answering && streaming && chatId && !(questionWaits && canSend) ? (
            <Tooltip text="Stop the answer" placement="top">
              <button type="button" className="kb-send is-stop" aria-label="Stop the answer"
                onClick={async () => { const r = await chats.getState().stop(chatId, streaming.id); if (!r.ok) setError(r.error); }}>
                <Icon name="stop" size={12} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip text={blocked ? 'The agent is still answering' : 'Send (Enter)'} placement="top">
              <button type="button" className="kb-send" aria-label="Send" aria-disabled={!canSend || sending || blocked || undefined}
                onClick={() => void submit()} data-busy={sending || undefined}>
                <Icon name="send" size={14} />
              </button>
            </Tooltip>
          )}
        </div>
        {error && (
          <p className="kb-composer__error" role="alert">
            {error}{agentError && !agentReady && <> <AgentFix agent={agent} /></>}
          </p>
        )}
      </div>
    </>
  );
}

export type { KbQuote };
export { isSpeechFile };
