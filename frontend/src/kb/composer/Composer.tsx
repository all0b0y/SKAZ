import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useMentionDrop } from './MentionDrop';
import type { KbMessageInput, KbQuote } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Icon, IconButton, useIconPlay } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { agentOf, answeringModel, startingChoice } from '../state/agents';
import { isAnswering, isLocal, type AgentChoice } from '../state/chats';
import { partsOf } from '../api/permissions';
import { useAgents, useChats, useComposerBus, useLibrary, useRecording, useServices, useSettings, useUi } from '../state/context';
import { AgentPicker, EffortPicker } from './AgentPicker';
import { ChatSearchButton } from '../searchRules/ChatSearchPanel';
import { addMaterial, attachmentKey, AttachButton, isSpeechFile, type Attachment } from './Attach';
import { DICTATION_MAX_S, startCapture, type Capture } from './dictation';
import { clearEditor, insertText, insertToken, isEmpty, markGone, mentionAtCaret, serialize, type MentionMatch } from './editor';
import { MentionPopup, useMentions, type MentionOption } from './MentionPopup';
import { isLongPaste, PastedCard, pastedName } from './PastedText';
import { QuickQuestions } from './QuickQuestions';
import { openTarget } from '../state/document';
import { extensionOf } from '../materials/addItems';
import { ingestWhenReady } from '../materials/ingestWhenReady';
import { AgentFix } from '../chat/AgentFix';
import { useOpenStudy } from '../study/useStudy';
import { StudyContextChip } from '../study/StudyBlock';
import { useSelection, useSelectionStore } from '../chat/select/context';
import { QUICK_TEXT, type QuickAsk } from '../chat/select/SelectionBar';
import { SelectionPanel } from '../chat/select/WhereFrom';
import { AttachmentDraftStrip } from './attachmentDrafts041/AttachmentDraftStrip';
import { attachmentSendBlocker, NEW_CHAT_DRAFT, useAttachmentDraft, type DraftAttachment, type DraftFile } from './attachmentDrafts041/draft';
import { prepareDraftSelection, prepareSpeechFile } from './attachmentDrafts041/nativeIntake';

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
    return startingChoice(agents, agents.default);
  }, [chat, draft, agents]);
}

/**
 * Message field (v3/v4/v21/v39): text with @-mention and quote tokens, "+" attachments, agent +
 * model + effort, dictation, send/stop. Height grows like text up to five lines, then scrolls.
 */
export function Composer({ chatId, placeholder, active: paneActive = true, handleImagePaste }: {
  chatId: string | null;
  placeholder: string;
  active?: boolean;
  handleImagePaste?: (event: ClipboardEvent<HTMLDivElement>) => boolean;
}) {
  const services = useServices();
  const { bridge, client, chats } = services;
  const editorRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [empty, setEmpty] = useState(true);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [active, setActive] = useState(0);
  const [sendPlay, replaySend] = useIconPlay();
  const [dictation, setDictation] = useState<Dictation>({ phase: 'idle' });
  const [hover, setHover] = useState<{ text: string; left: number; top: number } | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const { drafts, attachmentDrafts } = services.composer.getState();
  const draftState = attachmentDrafts.getState;
  const key = chatId ?? NEW_CHAT_DRAFT;
  const { attachments, sending, error } = useAttachmentDraft(attachmentDrafts, key);
  const draftKey = useRef<string | null>(null);
  const choosingFiles = useRef(new Set<string>());
  const canChangeDraft = () => paneActive && draftKey.current === key
    && (chats.getState().currentId ?? NEW_CHAT_DRAFT) === key
    && !draftState().getDraft(key).sending;
  const setError = (message: string | null) => draftState().setError(key, message);
  const setAttachments = (change: (items: readonly DraftAttachment[]) => readonly DraftAttachment[]) =>
    draftState().update(key, change);
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
  // P2: items picked in an answer (chat/select): the field asks about them.
  const { selection, clear: clearSelection } = useSelection();
  const selectionStore = useSelectionStore();

  const agent = choice ? agentOf(agents, choice.engine) : undefined;
  // Bug 5: "as set in the agent" (no model) still offers effort — the levels of the model that answers.
  const model = answeringModel(agent, choice?.model);
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

  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    draftKey.current = key;
    lastPaste.current = null;
    root.replaceChildren(...(drafts.get(key) ?? []));
    drafts.delete(key);
    refresh();
    return () => {
      if (!isEmpty(root)) drafts.set(key, Array.from(root.childNodes));
      clearEditor(root);
      draftKey.current = null;
    };
  }, [key, refresh, drafts]);

  // Items handed over from elsewhere (selection toolbar, decisions). After the chat switch above, so
  // a hand-off that opens another chat lands in that chat's field (QA D2).
  useEffect(() => {
    if (!queued || !paneActive) return;
    const root = editorRef.current;
    if (!root) return;
    const items = services.composer.getState().take();
    for (const item of items) {
      if (item.kind === 'quote') insertToken(root, { kind: 'quote', quote: item.quote });
      else if (item.kind === 'mention') insertToken(root, { kind: 'mention', ref: item.ref });
      else if (item.kind === 'selection') selectionStore?.getState().set(item.selection); // P3-c: the chip
      else insertText(root, item.text);
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, key, paneActive]);


  // A material deleted while it is referenced here (QA B8): its token is marked and its
  // attachment says so; neither can be sent.
  useEffect(() => {
    if (editorRef.current) markGone(editorRef.current, gone);
    draftState().update(key, (list) => (list.some((a) => a.materialId && gone.has(a.materialId) && a.state !== 'failed')
      ? list.map((a) => (a.materialId && gone.has(a.materialId) ? { ...a, state: 'failed', error: 'This material was deleted.' } : a))
      : list));
  }, [gone, key, draftState]);

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
  const materialSaved = () => { void services.library.getState().loadContent(); };
  const saveMaterial = (source: 'file' | 'link' | 'text', value: string, folderId: string) =>
    addMaterial(client, source, value, folderId).then((added) => {
      materialSaved();
      return added;
    });

  const addAttachments = (items: Array<{ source: Exclude<Attachment['source'], 'file'>; name: string; value: string; materialId?: string }>) => {
    if (!canChangeDraft()) return;
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
      if (item.source === 'existing') continue;
      saveMaterial(item.source, item.value, inboxId).then(
        (added) => setAttachments((list) => list.map((a) => (a.key === key
          ? { ...a, state: 'ready', materialId: added.id, materialReady: added.ready, ...(added.existing ? { alreadyInLibrary: true } : {}) }
          : a))),
        (e: unknown) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'failed', error: errorText(e) } : a))),
      );
    }
  };

  const chooseFiles = async (replaceKey?: string) => {
    if (!canChangeDraft() || choosingFiles.current.has(key)) return;
    choosingFiles.current.add(key);
    let files: DraftFile[];
    try {
      const native = bridge.nativeIntake;
      if (native) {
        const { accepted, rejected } = await native.chooseMaterialFiles();
        files = [
          ...accepted.map((selection) => ({
            name: selection.name,
            load: () => prepareDraftSelection(native, inboxId, selection, materialSaved),
          })),
          ...rejected.map(({ name, reason }) => ({
            name,
            load: async () => { throw new Error(reason); },
          })),
        ];
      } else {
        const chosen = await bridge.chooseMaterialFiles?.() ?? [];
        files = chosen.map(({ name, path }) => ({
          name,
          load: () => prepareSpeechFile(name, extensionOf(path), async () => {
            if (!inboxId) throw new Error('Connect the library first.');
            return saveMaterial('file', path, inboxId);
          }),
        }));
      }
    } catch (e) {
      setError(errorText(e));
      return;
    } finally {
      choosingFiles.current.delete(key);
    }
    await draftState().addFiles(key, files, wiki?.auto_add_files_links ?? true, replaceKey);
  };

  const study = useOpenStudy(chatId);
  const openContext = () => ({
    ...(doc ? (doc.type === 'page' ? { open_page_id: doc.id } : { open_material_id: doc.id }) : {}),
    ...(study ? { open_study_id: study.id } : {}),
  });

  // Quick questions while recording: the recording goes along as an attached material, so the agent
  // reads its transcribed fragments only — never the words still being recognised.
  const blocker = attachmentSendBlocker(attachments);
  const quickReason = blocker ?? (!agentReady ? unavailable : blocked ? 'The agent is still answering' : null);
  const askQuick = async (text: string) => {
    const draft = draftState().getDraft(key);
    if (!recId || !canChangeDraft() || choosingFiles.current.has(key) || attachmentSendBlocker(draft.attachments) || quickReason) return;
    draftState().setSending(key, true);
    setError(null);
    const result = await chats.getState().send({ text, mentions: [], quotes: [], attachments: [recId] }, openContext());
    draftState().setSending(key, false);
    if (!result.ok) setError(result.error);
  };
  const prefillQuick = (text: string) => {
    const root = editorRef.current;
    if (!root || !recId || !paneActive || sending || quickReason) return;
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

  /** `quick`: a quick ask of the selection bar (P2) — its words, then what was typed, if anything. */
  const submit = async (quick?: QuickAsk) => {
    const root = editorRef.current;
    const initial = draftState().getDraft(key);
    if (!root || !canChangeDraft() || choosingFiles.current.has(key) || attachmentSendBlocker(initial.attachments)) return;
    let owner = key;
    const value = serialize(root);
    const text = quick ? (value.text.trim() ? `${QUICK_TEXT[quick]}: ${value.text.trim()}` : QUICK_TEXT[quick]) : value.text;
    // Long pastes are cards until now: they become pasted-text materials only with the message.
    const unsaved = initial.attachments.filter((a) => a.text !== undefined && !a.materialId);
    if (!text.trim() && !value.mentions.length && !value.quotes.length && !unsaved.length
      && !initial.attachments.some((a) => a.state === 'ready' && a.materialId)) return;
    const deleted = [...markGone(root, gone), ...initial.attachments.filter((a) => a.materialId && gone.has(a.materialId)).map((a) => a.name)];
    if (deleted.length) { setError(`“${deleted[0]}” was deleted. Remove it from the message to send.`); return; }
    if (!agentReady) { setError(unavailable); return; }
    if (blocked) return;
    if (unsaved.length && !inboxId) { setError('Connect the library first.'); return; }
    draftState().setSending(key, true);
    setError(null);

    // Remove only the submitted text. New hand-offs can arrive in this editor during preparation.
    const submittedNodes = Array.from(root.childNodes);
    clearEditor(root);
    lastPaste.current = null;
    refresh();
    const restore = () => {
      if (draftKey.current === owner && editorRef.current) {
        editorRef.current.prepend(...submittedNodes);
        refresh();
      } else if (submittedNodes.length) {
        drafts.set(owner, [...submittedNodes, ...(drafts.get(owner) ?? [])]);
      }
      draftState().setSending(owner, false);
    };

    if (unsaved.length && inboxId) {
      const keys = new Set(unsaved.map((a) => a.key));
      setAttachments((now) => now.map((a) => (keys.has(a.key) ? { ...a, state: 'adding', error: null } : a)));
      const saved = await Promise.all(unsaved.map((a) => saveMaterial('text', a.text!, inboxId).then(
        (added) => ({ key: a.key, id: added.id as string | null, ready: added.ready, error: null as string | null }),
        (e: unknown) => ({ key: a.key, id: null, ready: false, error: errorText(e) }),
      )));
      const byKey = new Map(saved.map((r) => [r.key, r]));
      const settle = (a: DraftAttachment): DraftAttachment => {
        const r = byKey.get(a.key);
        if (!r) return a;
        return r.id ? { ...a, state: 'ready', materialId: r.id, materialReady: r.ready, error: null } : { ...a, state: 'failed', error: r.error };
      };
      setAttachments((now) => now.map(settle));
    }
    const list = draftState().getDraft(key).attachments;
    if (attachmentSendBlocker(list)) { restore(); return; }
    // A file can be removed from Materials while an unsaved pasted-text card is being imported.
    const latestGone = new Set(services.library.getState().gone);
    if (list.some((a) => a.materialId && latestGone.has(a.materialId))) {
      setAttachments((items) => items.map((a) => a.materialId && latestGone.has(a.materialId)
        ? { ...a, state: 'failed', error: 'This material was deleted.' }
        : a));
      restore();
      return;
    }
    const ready = list.filter((a) => a.state === 'ready' && a.materialId);
    const input: KbMessageInput = { text, mentions: value.mentions, quotes: value.quotes, attachments: ready.map((a) => a.materialId!),
      ...(selection ? { selection: { ...selection, intent: quick ?? 'ask' } } : {}) };
    if (draftKey.current === key) replaySend();
    const result = await chats.getState().send(input, openContext(), {
      draftChatId: chatId,
      onDraftChatActivated: (createdId) => {
        draftState().move(key, createdId);
        owner = createdId;
      },
    });
    if (!result.ok) {
      restore();
      draftState().setError(owner, result.error);
      return;
    }
    if (input.selection && draftKey.current === owner && selectionStore?.getState().selection === selection) clearSelection();
    const sentKeys = new Set(ready.map((item) => item.key));
    draftState().update(owner, (items) => items.filter((item) => !sentKeys.has(item.key)));
    draftState().setSending(owner, false);
    // "In wiki" (decision 15): new materials were held out of the wiki; the ticked ones go in now.
    for (const a of ready) {
      if (a.source !== 'existing' && !a.alreadyInLibrary && a.inWiki) {
        ingestWhenReady(client, a.materialId!, a.materialReady, (text) => {
          draftState().setError(owner, `“${a.name}” is saved to Materials but couldn’t go to the wiki yet: ${text} You can add it from Materials later.`);
        });
      }
    }
  };

  /** Put a pasted-text card back into the field as plain text. */
  const pasteAsText = (itemKey: string) => {
    const root = editorRef.current;
    if (!root || !canChangeDraft()) return;
    const card = draftState().getDraft(key).attachments.find((a) => a.key === itemKey);
    if (card?.text === undefined || card.state === 'adding') return;
    lastPaste.current = null;
    setAttachments((list) => list.filter((a) => a.key !== itemKey));
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
    if (selection && event.key === 'Escape') { event.preventDefault(); clearSelection(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!event.repeat) void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!canChangeDraft()) { event.preventDefault(); return; }
    if (handleImagePaste?.(event)) { lastPaste.current = null; return; }
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
        if (draftKey.current === key && editorRef.current && res.data.text.trim()) {
          editorRef.current.focus();
          insertText(editorRef.current, res.data.text.trim());
          refresh();
        } else if (res.data.text.trim()) {
          drafts.set(key, [...(drafts.get(key) ?? []), document.createTextNode(` ${res.data.text.trim()}`)]);
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
  const canEdit = paneActive && !sending;
  const placeholderShown = empty && dictation.phase === 'idle';
  const hint = selection ? 'Ask about the selection…' : placeholder;
  // A query of several words stays a mention only while something matches; otherwise it is just text.
  const popupOpen = mention !== null && (!mention.query.includes(' ') || mentions.loading || mentions.options.length > 0);
  const canSend = !empty || attachments.some((a) => a.state === 'ready' || a.text !== undefined);
  const focusEditor = useCallback(() => editorRef.current?.focus({ preventScroll: true }), []);
  const toggleWiki = (itemKey: string) => {
    if (canChangeDraft()) {
      setAttachments((list) => list.map((a) => (a.key === itemKey ? { ...a, inWiki: !a.inWiki } : a)));
    }
  };
  const removeAttachment = (itemKey: string) => {
    if (!canChangeDraft()) return;
    if (lastPaste.current === itemKey) lastPaste.current = null;
    setAttachments((list) => list.filter((a) => a.key !== itemKey && a.replaceKey !== itemKey));
  };
  const resolveVideo = (itemKey: string, proceed: boolean) => {
    if (canChangeDraft() && draftState().resolveVideo(key, itemKey, proceed)) focusEditor();
  };

  return (
    <>
      {recPhase === 'recording' && recId && (
        <QuickQuestions disabledReason={quickReason} onAsk={(q) => void askQuick(q)} onPrefill={prefillQuick} />
      )}
      {study && chatId && <StudyContextChip chatId={chatId} part={study} />}
      <div className="kb-composer" data-testid="composer" {...(canEdit ? mentionDrop.handlers : {})}>
        {canEdit && mentionDrop.overlay}
        {selection && (
          <SelectionPanel selection={selection} onClear={clearSelection} onQuick={(ask) => void submit(ask)}
            disabledReason={blocker ?? (!agentReady ? unavailable : blocked ? 'The agent is still answering' : sending ? 'Sending…' : null)} />
        )}
        {popupOpen && (
          <MentionPopup id={listId} options={mentions.options} active={active} loading={mentions.loading} error={mentions.error}
            onPick={pickMention} onHover={setActive} />
        )}
        <AttachmentDraftStrip key={key} items={paneActive ? attachments : []} readOnly={sending} focusEditor={focusEditor}
          onReplace={bridge.nativeIntake ? (itemKey) => void chooseFiles(itemKey) : undefined}
          onToggleWiki={toggleWiki}
          onRemove={removeAttachment}
          onResolveVideo={resolveVideo}
          renderName={(a) => (a.text !== undefined ? <PastedCard attachment={a} text={a.text} onPasteAsText={() => pasteAsText(a.key)}
            onToggleWiki={() => toggleWiki(a.key)} readOnly={sending} /> : null)} />
        <div className="kb-editor-wrap">
          {placeholderShown && <span className="kb-editor__placeholder" aria-hidden="true">{hint}</span>}
          <div
            ref={editorRef}
            className="kb-editor"
            contentEditable={canEdit}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-readonly={!canEdit || undefined}
            aria-label="Message"
            aria-placeholder={hint}
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
          <AttachButton key={key} onAdd={addAttachments} disabled={!paneActive || sending}
            onChooseFiles={bridge.nativeIntake || bridge.chooseMaterialFiles ? () => void chooseFiles() : undefined} />
          <ChatSearchButton chatId={chatId} />
          <span className="kb-composer__spacer" />
          {dictation.phase === 'recording' && (
            <span className="kb-dictating" role="status"><span className="kb-dictating__dot" aria-hidden="true" />Listening</span>
          )}
          <AgentPicker choice={choice} existingChat={chatId !== null}
            onChoose={async (next) => {
              setError(null);
              const res = await chats.getState().setAgent(chatId, next);
              if (!res.ok) setError(res.error);
              else services.agents.getState().noteLastChoice(next.engine, next.model, next.effort);
            }} />
          {choice && model && (
            <EffortPicker efforts={model.efforts} value={choice.effort ?? model.default_effort}
              onChange={async (effort) => {
                const res = await chats.getState().setAgent(chatId, { ...choice, effort });
                if (!res.ok) setError(res.error);
                else services.agents.getState().noteLastChoice(choice.engine, choice.model, effort);
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
          {answering && streaming && chatId && !isLocal(streaming.id) && !(questionWaits && canSend) ? (
            <Tooltip text="Stop the answer" placement="top">
              <button type="button" className="kb-send is-stop" aria-label="Stop the answer"
                onClick={async () => { const r = await chats.getState().stop(chatId, streaming.id); if (!r.ok) setError(r.error); }}>
                <Icon name="stop" size={12} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip text={blocked ? 'The agent is still answering' : 'Send (Enter)'} placement="top">
              <button type="button" className="kb-send" aria-label="Send" aria-disabled={!paneActive || !canSend || sending || blocked || !!blocker || undefined}
                onClick={() => void submit()} data-busy={sending || undefined}>
                <Icon name="send" size={14} play={sendPlay} />
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
