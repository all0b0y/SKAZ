import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient, ApiError } from '../../api/client';
import { useStore } from '../../state/store';
import { EmptyState } from '../ui/EmptyState';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
import { findCitationForSelection } from '../../lib/citationMatch';
import { copyToClipboard } from '../../lib/clipboard';
import type { SaveStatus } from '../../lib/autosave';
import { NoteEditor, type EditorSelection } from './NoteEditor';
import { NoteTabsBar } from './NoteTabsBar';
import { OpenNoteDialog } from './OpenNoteDialog';
import { RewriteDiff } from './RewriteDiff';
import {
  activeTab as activeTabOf,
  attachNote,
  closeTab,
  loadTabs,
  noteName,
  openTab,
  pruneTabs,
  renameTab,
  saveTabs,
  selectTab,
  titleFromContent,
  type NoteTab,
  type TabsState,
} from '../../state/noteTabs';
import { NoteList } from './NoteList';
import type { Citation, Note, NoteDetail } from '../../api/types';

interface NotesPanelProps {
  onCite: (citation: Citation) => void;
  /** Offered next to a "no model configured" failure, which is only fixable there. */
  onOpenSettings?: () => void;
}

const COPY_FEEDBACK_MS = 1_500;
const DETAIL_KEY = 'audiohelper.noteDetail';

/** An open context menu over the document, with the selection it was raised on. */
interface MenuState extends EditorSelection {
  /** The stored citation the selection resolves to, or null when it resolves to none. */
  citation: Citation | null;
}

/** A written replacement being compared against the passage it would replace. */
interface RewriteState {
  previewId: string;
  original: string;
  replacement: string;
  applying: boolean;
  error: string | null;
}

const loadDetail = (): NoteDetail => {
  const stored = localStorage.getItem(DETAIL_KEY);
  return stored === 'brief' || stored === 'detailed' ? stored : 'normal';
};

/**
 * Notes as a small editor, not a viewer with an edit button.
 *
 * Open documents live in tabs the way a browser or Obsidian does, each pinned to
 * the session it was written from — so a note generated from one lecture keeps
 * citing that lecture even while the sidebar shows another. The text is always
 * editable and saves itself; nothing here asks the user to confirm a save, and the
 * save state is a single quiet dot in the tab strip rather than a line of prose.
 *
 * There is no session heading above the tabs: the session is already named in the
 * sidebar, and repeating it here only pushed the document down the pane.
 *
 * Sources are not displayed. A generated point that still resolves to speech offers
 * "Показать в записи" when it is selected; a point the user wrote themselves offers
 * nothing, and the note reads as an ordinary document either way.
 */
export function NotesPanel({ onCite, onOpenSettings }: NotesPanelProps) {
  const sessionDetail = useStore((s) => s.detail);
  const generating = useStore((s) => s.notesGenerating);
  const error = useStore((s) => s.notesError);
  const recorderState = useStore((s) => s.recorderState);
  const generate = useStore((s) => s.generateNotes);
  const createEmptyNote = useStore((s) => s.createEmptyNote);
  const renameNote = useStore((s) => s.renameNote);
  const deleteNote = useStore((s) => s.deleteNote);
  const refreshTranscriptSource = useStore((s) => s.refreshTranscriptSource);
  const setAskContext = useStore((s) => s.setAskContext);
  const activeId = useStore((s) => s.activeSessionId);
  const settings = useStore((s) => s.settings);

  const [tabs, setTabs] = useState<TabsState>(() => loadTabs());
  const [noteDetail, setNoteDetail] = useState<NoteDetail>(loadDetail);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rewrite, setRewrite] = useState<RewriteState | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  // Why a generation tab is not showing a document: still running, or failed.
  const [pendingError, setPendingError] = useState<string | null>(null);

  const allNotes = useMemo(
    () => sessionDetail?.notes_list ?? (sessionDetail?.notes ? [sessionDetail.notes] : []),
    [sessionDetail],
  );
  const capturing = recorderState === 'recording' || recorderState === 'processing';
  const hasSegments = (sessionDetail?.segments.length ?? 0) > 0;
  // Only once settings are actually loaded. An unread settings document must not
  // be reported as "no model chosen" — that would be a guess about the config.
  const notesModelMissing = !!settings && !settings.notes.model;

  useEffect(() => saveTabs(tabs), [tabs]);

  // Finals can still land after Stop, and nothing else refreshes the stored
  // transcript while the user sits on this tab. Without this read, generation
  // stays refused with "Нет транскрипции" over a session that has one.
  useEffect(() => {
    if (!activeId || capturing) return;
    void refreshTranscriptSource();
  }, [activeId, capturing, refreshTranscriptSource]);

  // A tab pointing at a note of the *current* session that no longer exists is
  // dropped. Tabs of other sessions are left alone: their notes are simply not
  // loaded right now, and closing them would throw away the user's working set.
  useEffect(() => {
    if (!activeId || !sessionDetail) return;
    const known = new Set(allNotes.map((note) => note.id));
    setTabs((state) => pruneTabs(state, (tab) =>
      tab.sessionId !== activeId || tab.noteId === null || known.has(tab.noteId)));
  }, [activeId, sessionDetail, allNotes]);

  const current: NoteTab | null = activeTabOf(tabs);
  const openNote: Note | null = current && current.sessionId === activeId && current.noteId
    ? allNotes.find((note) => note.id === current.noteId) ?? null
    : null;

  // Every reason generation is refused, stated on the control itself rather than
  // left as a dead button the user has to guess about.
  const generateHint = capturing
    ? 'Остановите запись'
    : !hasSegments ? 'Нет транскрипции'
    : notesModelMissing ? 'Не выбрана модель' : null;
  const canGenerate = !!activeId && hasSegments && !capturing && !notesModelMissing;

  /**
   * Run one generation into an already open tab.
   *
   * The tab exists before the request so the user sees that something started;
   * the note does not, because a failed generation must not leave an empty
   * document behind. Binding happens only once the note actually arrives, and a
   * tab closed meanwhile is left closed — the note is in the list either way.
   */
  const runGeneration = useCallback(async (pendingTabId: string) => {
    const note = await generate(noteDetail);
    if (!note?.id) {
      // The tab stays, carrying the reason and a retry: a vanishing tab loses
      // which generation failed, and the panel-wide banner cannot say.
      setPendingError(useStore.getState().notesError ?? 'Не удалось создать конспект');
      return;
    }
    setPendingError(null);
    setTabs((state) => {
      if (!state.tabs.some((tab) => tab.id === pendingTabId)) return state;
      return renameTab(attachNote(state, pendingTabId, note.id!), pendingTabId, noteName(note));
    });
  }, [generate, noteDetail]);

  const handleGenerate = useCallback(async () => {
    if (!activeId) return;
    setPendingError(null);
    let pendingTabId = '';
    setTabs((state) => {
      const opened = openTab(state, { sessionId: activeId, noteId: null, title: 'Генерация…' });
      pendingTabId = opened.activeTabId ?? '';
      return opened;
    });
    await runGeneration(pendingTabId);
  }, [activeId, runGeneration]);

  /** Retry inside the tab that failed, rather than stacking another one beside it. */
  const handleRetry = useCallback(async () => {
    const tabId = tabs.activeTabId;
    if (!tabId) return;
    setPendingError(null);
    setTabs((state) => renameTab(state, tabId, 'Генерация…'));
    await runGeneration(tabId);
  }, [tabs.activeTabId, runGeneration]);

  const handleCreateEmpty = useCallback(async () => {
    if (!activeId) return;
    const note = await createEmptyNote();
    if (!note?.id) return;
    setTabs((state) => openTab(state, { sessionId: activeId, noteId: note.id!, title: 'Без названия' }));
  }, [activeId, createEmptyNote]);

  /**
   * Rename the note a tab points at (decision 9).
   *
   * Only a tab of the session currently loaded can be renamed, because only then
   * is the stored note in hand — and the rename must carry the note's revision,
   * not a title the strip happens to display. A tab of another session is left
   * alone rather than renamed against a guess.
   */
  const handleRenameTab = useCallback((tab: NoteTab, title: string) => {
    if (tab.sessionId !== activeId || !tab.noteId) return;
    const target = allNotes.find((note) => note.id === tab.noteId);
    if (!target) return;
    // The strip updates at once so the name does not visibly lag the keystroke;
    // the store's own update follows when the write is accepted.
    setTabs((state) => renameTab(state, tab.id, title));
    void renameNote(target, title);
  }, [activeId, allNotes, renameNote]);

  /** Delete the note a tab points at (decision 14) and close the tab with it. */
  const handleDeleteTab = useCallback((tab: NoteTab) => {
    if (tab.sessionId !== activeId || !tab.noteId) return;
    setTabs((state) => closeTab(state, tab.id));
    void deleteNote(tab.noteId);
  }, [activeId, deleteNote]);

  /**
   * A right click inside the document raises the app's own menu.
   *
   * The citation is resolved once, here, so every entry of the menu agrees about
   * whether this passage rests on stored speech: "Показать в транскрипции" and
   * "Перегенерировать" are the same claim seen twice.
   */
  const handleEditorMenu = useCallback((selection: EditorSelection) => {
    setCopied(false);
    setMenu({
      ...selection,
      citation: selection.text && openNote
        ? findCitationForSelection(selection.text, openNote.citations)
        : null,
    });
  }, [openNote]);

  const handleCopy = () => {
    if (!menu?.text) return;
    void copyToClipboard(menu.text).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      }
    });
    setMenu(null);
  };

  /** Paste into the raw field the editor is in; the rendered view cannot take text. */
  const handlePaste = () => {
    setMenu(null);
    void navigator.clipboard?.readText?.().then((text) => {
      if (!text) return;
      const field = document.querySelector<HTMLTextAreaElement>('.note-editor__text');
      if (!field) return;
      const from = field.selectionStart ?? field.value.length;
      const to = field.selectionEnd ?? from;
      field.setRangeText(text, from, to, 'end');
      // React listens for input, not for a programmatic value change.
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch(() => undefined);
  };

  /**
   * Write a replacement for the selected passage and show it beside the original.
   *
   * Nothing is stored by this: the answer is a comparison the user accepts or
   * refuses. Only the exact span is sent, so the rest of the document — including
   * everything the user wrote themselves — is never at stake.
   */
  const handleRewrite = useCallback(async () => {
    if (!menu?.span || !openNote?.id || !activeId) return;
    const { start, end } = menu.span;
    setMenu(null);
    setRewriting(true);
    try {
      const preview = await new ApiClient(window.audiohelper)
        .rewritePassage(activeId, openNote, start, end, noteDetail);
      setRewrite({
        previewId: preview.id, original: preview.original,
        replacement: preview.replacement, applying: false, error: null,
      });
    } catch (error) {
      setRewriteError(error);
    } finally {
      setRewriting(false);
    }
  }, [menu, openNote, activeId, noteDetail]);

  const handleApplyRewrite = useCallback(async () => {
    if (!rewrite || !openNote?.id || !activeId) return;
    setRewrite({ ...rewrite, applying: true, error: null });
    try {
      const saved = await new ApiClient(window.audiohelper)
        .applyRewrite(activeId, openNote.id, rewrite.previewId);
      useStore.setState((state) => state.activeSessionId !== activeId || !state.detail ? {} : {
        detail: { ...state.detail, notes: saved,
          notes_list: allNotes.map((note) => note.id === saved.id ? saved : note) },
      });
      setRewrite(null);
    } catch (error) {
      setRewrite((state) => state && {
        ...state, applying: false,
        error: error instanceof ApiError ? error.message : 'Не удалось применить фрагмент',
      });
    }
  }, [rewrite, openNote, activeId, allNotes]);

  const setRewriteError = (error: unknown) => {
    useStore.setState({
      notesError: error instanceof ApiError ? error.message : 'Не удалось перегенерировать фрагмент',
    });
  };

  // The two ways to start a note. Identical whether they stand under an empty
  // state or under the session's list, so the pane does not offer two different
  // sets of controls for the same thing.
  const startButtons = (
    <>
      <button
        type="button"
        className="btn btn--primary notes__start-btn"
        disabled={!canGenerate || generating}
        title={generateHint ?? undefined}
        onClick={() => void handleGenerate()}
      >
        <span>Создать конспект с ИИ</span>
        {generateHint && <small>{generateHint}</small>}
      </button>
      <button
        type="button"
        className="btn btn--ghost notes__start-btn"
        disabled={!activeId}
        onClick={() => void handleCreateEmpty()}
      >
        <span>Создать пустой</span>
      </button>
    </>
  );

  return (
    <div className="notes">
      <NoteTabsBar
        tabs={tabs.tabs}
        activeTabId={tabs.activeTabId}
        detail={noteDetail}
        canGenerate={canGenerate}
        generateHint={generateHint}
        generating={generating}
        saveStatus={openNote && current && activeId ? saveStatus : null}
        onSelect={(id) => setTabs((state) => selectTab(state, id))}
        onClose={(id) => setTabs((state) => closeTab(state, id))}
        onRename={handleRenameTab}
        onDelete={handleDeleteTab}
        onCreateEmpty={() => void handleCreateEmpty()}
        onCreateGenerated={() => void handleGenerate()}
        onOpenExisting={() => setPicking(true)}
        onDetailChange={(next) => {
          setNoteDetail(next);
          localStorage.setItem(DETAIL_KEY, next);
        }}
      />

      {/* A missing model is a settings problem, so the way to fix it is offered
          here instead of leaving the user to find the drawer themselves. */}
      {notesModelMissing && (
        <p className="notes__notice" role="status">
          Модель для конспектов не выбрана — генерация с ИИ недоступна. Пустой конспект
          можно создать и без модели.
          {onOpenSettings && (
            <button type="button" className="notes__notice-action" onClick={onOpenSettings}>
              Открыть настройки
            </button>
          )}
        </p>
      )}

      {/* A generation failure is reported inside its own tab (decision 12); the
          panel-wide banner cannot say which generation failed, so it must not
          repeat the same sentence over the whole pane. */}
      {error && !pendingError && <p className="notes__error" role="alert">{error}</p>}

      <div className="notes__body">
        {/* A tab with no note behind it is a generation in flight — or one that
            failed. Either way the user sees which tab it was, instead of a banner
            over the whole panel that cannot say. */}
        {current && !openNote && !pendingError && generating && (
          <div className="note-pending" role="status" aria-label="Генерация конспекта">
            <span className="note-pending__spinner" aria-hidden="true" />
            <p>Читаю транскрипцию и собираю конспект…</p>
          </div>
        )}

        {current && !openNote && pendingError && (
          <div className="note-pending note-pending--failed">
            <p role="alert">{pendingError}</p>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canGenerate || generating}
              onClick={() => void handleRetry()}
            >
              Повторить
            </button>
          </div>
        )}

        {!current && (
          <>
            {/* Notes the session already has are shown on arrival. Guessing that
                they live behind a "+" menu is what made them feel lost. */}
            <NoteList
              notes={allNotes}
              onOpen={(note) => setTabs((state) => openTab(state, {
                sessionId: activeId!, noteId: note.id!, title: noteName(note),
              }))}
              onRename={(note, title) => void renameNote(note, title)}
              onDelete={(note) => void deleteNote(note.id!)}
            />
            {/* The icon, heading and hint only explain a pane that shows nothing.
                Above an actual list they are noise that pushes the notes down, so
                once there is a list only the two start buttons remain. */}
            {allNotes.length > 0 ? (
              <div className="notes__start notes__start--compact">{startButtons}</div>
            ) : (
              <EmptyState
                icon="notes"
                title="Нет конспектов"
                hint="Создайте конспект с ИИ или пустой — те же действия есть в меню «+» над этим полем."
              >
                <div className="notes__start">{startButtons}</div>
              </EmptyState>
            )}
          </>
        )}

        {openNote && current && activeId && (
          <div className="notes__content-wrap">
            <NoteEditor
              key={`${activeId}:${openNote.id}`}
              sessionId={activeId}
              note={openNote}
              onStatusChange={setSaveStatus}
              onSaved={(saved) => {
                useStore.setState((state) => state.activeSessionId !== activeId || !state.detail ? {} : {
                  detail: { ...state.detail, notes: saved,
                    notes_list: allNotes.map((note) => note.id === saved.id ? saved : note) },
                });
                setTabs((state) => renameTab(state, current.id, noteName(saved)));
                if (!current.noteId && saved.id) {
                  setTabs((state) => attachNote(state, current.id, saved.id!));
                }
              }}
              onContextMenu={handleEditorMenu}
            />
          </div>
        )}
      </div>

      {/* One menu over the document, raised where the pointer is. Actions that
          need stored speech behind the selection stay visible and say why they
          cannot run, so the user can see that the action exists at all. */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Действия с фрагментом"
          onDismiss={() => setMenu(null)}
        >
          <ContextMenuItem
            disabled={!menu.citation}
            hint={menu.text ? 'Источник не найден' : 'Ничего не выделено'}
            onClick={() => {
              if (!menu.citation) return;
              onCite(menu.citation);
              setMenu(null);
            }}
          >
            Показать в транскрипции
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menu.text}
            hint="Ничего не выделено"
            onClick={() => {
              setAskContext({ text: menu.text, citation: menu.citation });
              setMenu(null);
            }}
          >
            Ask
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menu.citation || !menu.span || rewriting}
            hint={!menu.text ? 'Ничего не выделено'
              : !menu.citation ? 'Источник не найден'
              : !menu.span ? 'Фрагмент не найден в тексте' : 'Идёт перегенерация'}
            onClick={() => void handleRewrite()}
          >
            Перегенерировать
          </ContextMenuItem>
          <ContextMenuItem disabled={!menu.text} hint="Ничего не выделено" onClick={handleCopy}>
            {copied ? 'Скопировано' : 'Копировать'}
          </ContextMenuItem>
          <ContextMenuItem onClick={handlePaste}>Вставить</ContextMenuItem>
        </ContextMenu>
      )}

      {rewrite && (
        <RewriteDiff
          original={rewrite.original}
          replacement={rewrite.replacement}
          applying={rewrite.applying}
          error={rewrite.error}
          onApply={() => void handleApplyRewrite()}
          onCancel={() => setRewrite(null)}
        />
      )}

      {picking && (
        <OpenNoteDialog
          onClose={() => setPicking(false)}
          onPick={(sessionId, note) => {
            setPicking(false);
            setTabs((state) => openTab(state, {
              sessionId, noteId: note.id!, title: titleFromContent(note.content) || 'Без названия',
            }));
          }}
        />
      )}
    </div>
  );
}
