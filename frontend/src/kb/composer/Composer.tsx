import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useMentionDrop } from './MentionDrop';
import type { KbMessageInput, KbOpenContext, KbQuote, KbRef, KbVisualPreflightResponse } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Icon, IconButton, useIconPlay } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { agentOf, answeringModel, startingChoice } from '../state/agents';
import { backgroundActivity, isLocal, latestStreamingAnswer, type AgentChoice, type ChatsData } from '../state/chats';
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
import { attachmentSendBlocker, canAddAttachmentToWiki, NEW_CHAT_DRAFT, useAttachmentDraft, type DraftAttachment, type DraftFile } from './attachmentDrafts041/draft';
import { prepareDraftSelection, prepareSpeechFile } from './attachmentDrafts041/nativeIntake';
import { VisualFallbackCard } from './visualFallback041/VisualFallbackCard';
import {
  clearDraftFallback,
  createFallbackSeam,
  getDraftFallback,
  resolveComposerSubmitGate,
  setDraftFallback,
  type DraftFallbackMap,
} from './visualFallback041/state';
import type {
  UnsupportedVisualReason,
  VisualCapabilityDecision,
  VisualFallbackSeam,
  VisualSourceKind,
  VisualSourceLocator,
} from './visualFallback041/types';

const DISPLAY_PREFLIGHT_DELAY_MS = 300;

function seamFromPreflight(res: KbVisualPreflightResponse): { seam: VisualFallbackSeam; locator: VisualSourceLocator } {
  const decision: VisualCapabilityDecision = {
    engine: res.engine,
    modelId: res.model_id,
    state: res.state,
    supported: res.supported,
    transportSupportsImage: res.reason_code !== 'adapter_no_image_transport',
    modelSupportsImage: res.supported ? true : res.reason_code === 'model_no_image_input' ? false : null,
    reasonCode: (res.reason_code as UnsupportedVisualReason | null) ?? undefined,
    reason: res.detail,
  };
  const locator: VisualSourceLocator = {
    materialId: res.locator?.material_id ?? 'attachment',
    sourceKind: (res.locator?.source_kind as VisualSourceKind | undefined) ?? 'image',
    page: res.locator?.page ?? null,
    timestampMs: res.locator?.timestamp_ms ?? null,
    label: res.locator?.label ?? 'Attachment',
  };
  const seam = createFallbackSeam({
    decision,
    locator,
    textOnlyAvailable: res.text_only_available,
    compatibleModels: res.compatible_models.map((m) => ({
      engine: m.engine,
      modelId: m.model_id,
      label: m.label,
      provider: m.provider,
    })),
    reasonCode: (res.reason_code as UnsupportedVisualReason | null) ?? undefined,
    customTitle: res.title,
    customDetail: res.detail,
  });
  return { seam, locator };
}

type Dictation = { phase: 'idle' } | { phase: 'recording'; started: number } | { phase: 'transcribing' };

function chosenAgent(chat: AgentChoice | null, draft: AgentChoice | null, agents: Parameters<typeof startingChoice>[0] | null) {
  if (chat) return { engine: chat.engine, model: chat.model, effort: chat.effort };
  return draft ?? (agents ? startingChoice(agents, agents.default) : null);
}

const chatChoice = (state: ChatsData, chatId: string | null) =>
  chatId ? state.list.find((c) => c.id === chatId) ?? state.chats[chatId]?.chat ?? null : null;

function sameChoice(left: AgentChoice | null, right: AgentChoice | null): boolean {
  return left?.engine === right?.engine && left?.model === right?.model && left?.effort === right?.effort;
}

/** What the composer offers for a chat: its own agent, or the draft/default one for a new chat. */
export function useAgentChoice(chatId: string | null): AgentChoice | null {
  const chat = useChats((s) => chatChoice(s, chatId));
  const draft = useChats((s) => s.draftAgent);
  const agents = useAgents((s) => s.agents);
  return useMemo(() => chosenAgent(chat, draft, agents), [chat, draft, agents]);
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
  const [fallbacksByDraft, setFallbacksByDraft] = useState<DraftFallbackMap>({});
  const [pickerOpenSeq, setPickerOpenSeq] = useState(0);
  const chooseModelRef = useRef<HTMLButtonElement | null>(null);
  const [draftSnapshot, setDraftSnapshot] = useState<{ text: string; mentions: KbRef[]; quotes: KbQuote[] }>({
    text: '',
    mentions: [],
    quotes: [],
  });
  const captureRef = useRef<Capture | null>(null);
  const { drafts, attachmentDrafts } = services.composer.getState();
  const draftState = attachmentDrafts.getState;
  const key = chatId ?? NEW_CHAT_DRAFT;
  const { attachments, sending, error } = useAttachmentDraft(attachmentDrafts, key);
  const draftKey = useRef<string | null>(null);
  const choosingFiles = useRef(new Set<string>());
  const changingAgent = useRef(new Set<string>());
  const activation = useRef<object | null>(null);
  useLayoutEffect(() => {
    activation.current = paneActive ? {} : null;
    return () => { activation.current = null; };
  }, [key, paneActive]);
  const canChangeDraft = () => paneActive && draftKey.current === key
    && (chats.getState().currentId ?? NEW_CHAT_DRAFT) === key
    && !draftState().getDraft(key).sending;
  const setError = (message: string | null) => draftState().setError(key, message);
  const setAttachments = (change: (items: readonly DraftAttachment[]) => readonly DraftAttachment[]) =>
    draftState().update(key, change);
  /** The card of the paste just made: ⌘Z right after it puts the text into the field instead. */
  const lastPaste = useRef<string | null>(null);

  const entry = useChats((s) => chatId ? s.chats[chatId] : undefined);
  const open = entry?.chat ?? null;
  const background = backgroundActivity(entry);
  const streaming = background ? null : latestStreamingAnswer(open);
  const answering = background ? background.state === 'answering' : !!streaming;
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
    const serialized = serialize(root);
    setDraftSnapshot({ text: serialized.text, mentions: serialized.mentions, quotes: serialized.quotes });
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
    if (!root || !canChangeDraft()) return;
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
  const openContext = useCallback((): KbOpenContext => ({
    ...(doc ? (doc.type === 'page' ? { open_page_id: doc.id } : { open_material_id: doc.id }) : {}),
    ...(study ? { open_study_id: study.id } : {}),
  }), [doc, study]);

  const readyAttachmentIds = useMemo(
    () => attachments.filter((a) => a.state === 'ready' && a.materialId).map((a) => a.materialId!),
    [attachments],
  );
  const readyAttachmentKeys = useMemo(
    () => attachments.filter((a) => a.state === 'ready' && a.materialId).map((a) => a.key),
    [attachments],
  );
  const openMaterialId = doc?.type === 'material' ? doc.id : null;
  const hasVisualCandidate = readyAttachmentIds.length > 0
    || draftSnapshot.mentions.some((m) => m.type === 'material')
    || openMaterialId !== null;
  const context = openContext();
  const latestContext = useRef(openContext);
  useLayoutEffect(() => { latestContext.current = openContext; }, [openContext]);
  const admissionKey = (text: string, value: typeof draftSnapshot, ids: readonly string[], keys: readonly string[]) =>
    JSON.stringify([choice?.engine, choice?.model, text, value.mentions, value.quotes, ids, keys, context]);
  const displayedKey = admissionKey(draftSnapshot.text, draftSnapshot, readyAttachmentIds, readyAttachmentKeys);
  const cachedFallback = getDraftFallback(fallbacksByDraft, key);
  const activeFallback = cachedFallback?.requestKey === displayedKey ? cachedFallback : null;

  useEffect(() => {
    if (sending || !paneActive) return;
    if (!hasVisualCandidate || !choice) {
      setFallbacksByDraft((prev) => clearDraftFallback(prev, key));
      return;
    }
    let cancelled = false;
    // Display can wait for a typing pause. Submit checks its own snapshot immediately.
    const timer = window.setTimeout(() => {
      if (draftState().getDraft(key).sending) return;
      void client.call('POST /kb/chats/visual-preflight', {
        body: {
          chat_id: chatId,
          engine: choice.engine,
          model: choice.model,
          text: draftSnapshot.text,
          mentions: draftSnapshot.mentions,
          quotes: draftSnapshot.quotes,
          attachments: readyAttachmentIds,
          context: openContext(),
        },
      }).then((res) => {
        if (cancelled) return;
        if (!res.requires_visual || res.supported) {
          setFallbacksByDraft((prev) => {
            const refusal = prev[key];
            // Discovery can still succeed after the renderer failed on this exact draft.
            return res.requires_visual && refusal?.fromSend && refusal.requestKey === displayedKey
              ? prev : clearDraftFallback(prev, key);
          });
          return;
        }
        const { seam, locator } = seamFromPreflight(res);
        setFallbacksByDraft((prev) => setDraftFallback(prev, key, {
          seam,
          draftText: draftSnapshot.text,
          attachmentKeys: readyAttachmentKeys,
          locator,
          requestKey: displayedKey,
        }));
      }).catch(() => {
        // Send revalidates visual requests on the server.
      });
    }, DISPLAY_PREFLIGHT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    paneActive,
    sending,
    hasVisualCandidate,
    key,
    chatId,
    choice,
    draftState,
    draftSnapshot,
    readyAttachmentIds,
    readyAttachmentKeys,
    openContext,
    displayedKey,
    client,
  ]);

  const chooseAgent = async (next: AgentChoice) => {
    if (changingAgent.current.has(key) || sameChoice(choice, next)) return;
    changingAgent.current.add(key);
    if (paneActive && draftKey.current === key) activation.current = {};
    setError(null);
    try {
      const result = await chats.getState().setAgent(chatId, next);
      if (!result.ok) setError(result.error);
      else services.agents.getState().noteLastChoice(next.engine, next.model, next.effort);
    } finally {
      changingAgent.current.delete(key);
    }
  };

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
  const submit = async (quick?: QuickAsk, opts?: { textOnly?: boolean }) => {
    const textOnly = Boolean(opts?.textOnly);
    const root = editorRef.current;
    const admittedFrom = activation.current;
    const initial = draftState().getDraft(key);
    if (!root || !admittedFrom || !canChangeDraft() || choosingFiles.current.has(key)
      || changingAgent.current.has(key) || attachmentSendBlocker(initial.attachments)) return;
    const value = serialize(root);
    const text = quick ? (value.text.trim() ? `${QUICK_TEXT[quick]}: ${value.text.trim()}` : QUICK_TEXT[quick]) : value.text;
    const unsaved = initial.attachments.filter((a) => a.text !== undefined && !a.materialId);
    const initialReady = initial.attachments.filter((a) => a.state === 'ready' && a.materialId);
    if (!text.trim() && !value.mentions.length && !value.quotes.length && !unsaved.length && !initialReady.length) return;
    const deleted = [...markGone(root, gone), ...initial.attachments.filter((a) => a.materialId && gone.has(a.materialId)).map((a) => a.name)];
    if (deleted.length) { setError(`“${deleted[0]}” was deleted. Remove it from the message to send.`); return; }
    if (!agentReady) { setError(unavailable); return; }
    if (blocked) return;
    if (unsaved.length && !inboxId) { setError('Connect the library first.'); return; }

    const initialReadyIds = initialReady.map((a) => a.materialId!);
    const initialReadyKeys = initialReady.map((a) => a.key);
    const mayNeedVisual = initialReadyIds.length > 0
      || value.mentions.some((m) => m.type === 'material')
      || context.open_material_id != null;
    const requestKey = admissionKey(text, value, initialReadyIds, initialReadyKeys);
    const fallback = cachedFallback?.requestKey === requestKey ? cachedFallback : null;
    if (textOnly && (!mayNeedVisual || !fallback?.seam.textOnlyAvailable || resolveComposerSubmitGate({
      requiresVisual: true, seam: fallback.seam, explicitTextOnlyChoice: true,
    }).action !== 'send_text_only')) return;
    if (!textOnly && fallback?.seam.unsupported && !fallback.fromSend) {
      chooseModelRef.current?.focus();
      return;
    }

    const editorSnapshot = root.innerHTML;
    const currentChoice = (state: ChatsData) =>
      chosenAgent(chatChoice(state, chatId), state.draftAgent, services.agents.getState().agents);
    const stillSelected = (state: ChatsData) => state.currentId === chatId && !state.allTabsClosed;
    let leftDraft = !stillSelected(chats.getState());
    let targetChanged = !sameChoice(choice, currentChoice(chats.getState()));
    const unsubscribe = chats.subscribe((state) => {
      leftDraft ||= !stillSelected(state);
      targetChanged ||= !sameChoice(choice, currentChoice(state));
    });
    const targetCurrent = () => !targetChanged && !changingAgent.current.has(key)
      && sameChoice(choice, currentChoice(chats.getState()));
    const stillAdmitting = () => !leftDraft && activation.current === admittedFrom
      && editorRef.current === root && root.innerHTML === editorSnapshot && targetCurrent()
      && latestContext.current === openContext
      && (selectionStore?.getState().selection ?? null) === selection;
    let owner = key;
    let submittedNodes: Node[] = [];
    const restore = () => {
      if (!submittedNodes.length) return;
      if (draftKey.current === owner && editorRef.current) {
        editorRef.current.prepend(...submittedNodes);
        refresh();
      } else {
        drafts.set(owner, [...submittedNodes, ...(drafts.get(owner) ?? [])]);
      }
    };

    // Lock this draft before preflight or material preparation enters its first await.
    draftState().setSending(key, true);
    setError(null);
    try {
      if (mayNeedVisual && choice && !textOnly) {
        const pre = await client.call('POST /kb/chats/visual-preflight', {
          body: {
            chat_id: chatId, engine: choice.engine, model: choice.model, text,
            mentions: value.mentions, quotes: value.quotes, attachments: initialReadyIds, context,
          },
        }).catch(() => null); // The server remains authoritative if a preflight result is unavailable.
        if (!stillAdmitting() || draftState().getDraft(key).attachments !== initial.attachments) return;
        if (pre?.requires_visual && !pre.supported) {
          const { seam, locator } = seamFromPreflight(pre);
          setFallbacksByDraft((prev) => setDraftFallback(prev, key, {
            seam, draftText: text, attachmentKeys: initialReadyKeys, locator, requestKey,
          }));
          window.requestAnimationFrame(() => {
            if (activation.current === admittedFrom) chooseModelRef.current?.focus();
          });
          return;
        }
      }

      if (!stillAdmitting() || draftState().getDraft(key).attachments !== initial.attachments) return;
      // After admission, detach only its snapshot. V2 can finish an admitted paste for its owner
      // while another tab is active, and any later handoff stays in the editor.
      submittedNodes = Array.from(root.childNodes);
      clearEditor(root);
      lastPaste.current = null;
      refresh();

      let list = initial.attachments;
      if (unsaved.length && inboxId) {
        const keys = new Set(unsaved.map((a) => a.key));
        setAttachments((now) => now.map((a) => (keys.has(a.key) ? { ...a, state: 'adding', error: null } : a)));
        const preparing = draftState().getDraft(key).attachments;
        const saved = await Promise.all(unsaved.map((a) => saveMaterial('text', a.text!, inboxId).then(
          (added) => ({ key: a.key, id: added.id as string | null, ready: added.ready, error: null }),
          (e: unknown) => ({ key: a.key, id: null, ready: false, error: errorText(e) }),
        )));
        const byKey = new Map(saved.map((r) => [r.key, r]));
        const current = draftState().getDraft(key).attachments;
        setAttachments((now) => now.map((a) => {
          const r = byKey.get(a.key);
          if (!r || a.state !== 'adding') return a;
          return r.id ? { ...a, state: 'ready', materialId: r.id, materialReady: r.ready, error: null }
            : { ...a, state: 'failed', error: r.error };
        }));
        // Preserve completed imports even if the admission that started them has since been cancelled.
        if (current !== preparing) return;
        list = draftState().getDraft(key).attachments;
      }
      if (!targetCurrent() || draftState().getDraft(key).attachments !== list || attachmentSendBlocker(list)) return;
      const latestGone = new Set(services.library.getState().gone);
      if (list.some((a) => a.materialId && latestGone.has(a.materialId))) {
        setAttachments((items) => items.map((a) => a.materialId && latestGone.has(a.materialId)
          ? { ...a, state: 'failed', error: 'This material was deleted.' }
          : a));
        return;
      }
      const ready = list.filter((a) => a.state === 'ready' && a.materialId);
      const input: KbMessageInput = { text, mentions: value.mentions, quotes: value.quotes, attachments: ready.map((a) => a.materialId!),
        ...(selection ? { selection: { ...selection, intent: quick ?? 'ask' } } : {}),
        ...(textOnly ? { text_only: true } : {}) };

      if (activation.current === admittedFrom) replaySend();
      const result = await chats.getState().send(input, context, {
        draftChatId: chatId,
        initialAgent: choice,
        expectedTarget: mayNeedVisual && choice ? choice : undefined,
        onDraftChatCreated: (createdId) => {
          draftState().move(key, createdId);
          owner = createdId;
        },
      });
      if (!result.ok) {
        const refusal = result.visualRefusal;
        if (refusal && refusal.engine === choice?.engine && refusal.model_id === choice.model) {
          const { seam, locator } = seamFromPreflight(refusal);
          const attachmentKeys = ready.map((item) => item.key);
          setFallbacksByDraft((prev) => setDraftFallback(prev, owner, {
            seam, locator, draftText: text, attachmentKeys, fromSend: true,
            requestKey: admissionKey(text, value, input.attachments, attachmentKeys),
          }));
        } else {
          draftState().setError(owner, result.error);
        }
        return;
      }
      submittedNodes = [];
      setFallbacksByDraft((prev) => clearDraftFallback(clearDraftFallback(prev, key), owner));
      if (input.selection && activation.current === admittedFrom
        && selectionStore?.getState().selection === selection) clearSelection();
      const sentKeys = new Set(ready.map((item) => item.key));
      draftState().update(owner, (items) => items.filter((item) => !sentKeys.has(item.key)));
      // New materials are held out of the wiki until the successful send.
      for (const a of ready) {
        if (a.inWiki && canAddAttachmentToWiki(a)) {
          ingestWhenReady(client, a.materialId!, a.materialReady, (detail) => {
            draftState().setError(owner, `“${a.name}” is saved to Materials but couldn’t go to the wiki yet: ${detail} You can add it from Materials later.`);
          });
        }
      }
    } catch (error) {
      draftState().setError(owner, errorText(error));
    } finally {
      unsubscribe();
      try {
        restore();
      } finally {
        draftState().setSending(owner, false);
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
      setAttachments((list) => list.map((a) => a.key === itemKey && canAddAttachmentToWiki(a)
        ? { ...a, inWiki: !a.inWiki }
        : a));
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
      {paneActive && activeFallback?.seam.unsupported && (
        <VisualFallbackCard
          seam={activeFallback.seam}
          busy={sending}
          chooseModelRef={chooseModelRef}
          onChooseModel={() => setPickerOpenSeq((n) => n + 1)}
          onContinueTextOnly={() => { void submit(undefined, { textOnly: true }); }}
        />
      )}
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
          <AgentPicker choice={choice} existingChat={chatId !== null} openRequest={pickerOpenSeq}
            onChoose={chooseAgent} />
          {choice && model && (
            <EffortPicker efforts={model.efforts} value={choice.effort ?? model.default_effort}
              onChange={(effort) => chooseAgent({ ...choice, effort })} />
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
