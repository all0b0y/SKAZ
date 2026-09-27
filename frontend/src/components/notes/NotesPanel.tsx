import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEdgeFade } from '../../hooks/useOverflowEdges';
import { ApiClient, ApiError } from '../../api/client';
import { useStore } from '../../state/store';
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu';
import { findCitationForSelection } from '../../lib/citationMatch';
import { copyToClipboard } from '../../lib/clipboard';
import type { SaveStatus } from '../../lib/autosave';
import { NoteEditor, type EditorHandle, type EditorSelection } from './NoteEditor';
import { NoteTabsBar } from './NoteTabsBar';
import { OpenNoteDialog } from './OpenNoteDialog';
import { RewriteDiff } from './RewriteDiff';
import {
  activeTab as activeTabOf,
  attachNote,
  emptyTabs,
  noteName,
  openTab,
  pruneTabs,
  renameTab,
  selectTab,
  type NoteTab,
  type TabsState,
} from '../../state/noteTabs';
import { NoteList } from './NoteList';
import { SetupNotice } from '../ui/SetupNotice';
import { SessionDialog } from '../sessions/SessionOverlays';
import type { Citation, Note, NoteDetail } from '../../api/types';
import { apiAgentBlock, engineOf, selectAgentNotes, useCodex } from '../../state/codex';
import { shareableNote } from '../../state/shareNote';
import { STATUS_LABEL, connectionBlockOf } from '../assistant/codexLabels';
import { CodexConnectionNotice } from '../assistant/CodexConnectionNotice';
import { openSettings } from '../../lib/openSettings';

interface NotesPanelProps {
  onCite: (citation: Citation) => void;
}

const COPY_FEEDBACK_MS = 1_500;
const DETAIL_KEY = 'skaz.noteDetail';

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
export function NotesPanel({ onCite }: NotesPanelProps) {
  const sessionDetail = useStore((s) => s.detail);
  const generation = useStore((s) => (s.activeSessionId ? s.noteGenerations[s.activeSessionId] : undefined));
  const error = useStore((s) => s.notesError);
  const recorderState = useStore((s) => s.recorderState);
  const generate = useStore((s) => s.generateNotes);
  const createEmptyNote = useStore((s) => s.createEmptyNote);
  const renameNote = useStore((s) => s.renameNote);
  const deleteNote = useStore((s) => s.deleteNote);
  const refreshTranscriptSource = useStore((s) => s.refreshTranscriptSource);
  const setAskContext = useStore((s) => s.setAskContext);
  const activeId = useStore((s) => s.activeSessionId);
  const detailLoading = useStore((s) => s.detailLoading);
  const settings = useStore((s) => s.settings);
  // Codex or API agent mode: either way the notes are a queued task that reads a snapshot.
  const agentOn = useCodex(selectAgentNotes);
  const codexOn = useCodex((s) => engineOf(s, 'notes') === 'codex');
  const apiBlock = useCodex((s) => apiAgentBlock(s, 'notes'));
  const codexSettings = useCodex((s) => s.settings);
  const codexConnection = useCodex((s) => s.connection);
  const codexTask = useCodex((s) => s.tasks.find((t) => t.id === generation?.taskId));
  // Each session keeps its own tabs (docs/NOTES-POLISH-SPEC.md §3), held by the
  // store so a generation can fill its tab after this panel has unmounted.
  const tabs = useStore((s) => (s.activeSessionId ? s.noteTabs[s.activeSessionId] : undefined)) ?? emptyTabs;
  const updateNoteTabs = useStore((s) => s.updateNoteTabs);
  const closeNoteTab = useStore((s) => s.closeNoteTab);
  const setTabs = useCallback((change: (state: TabsState) => TabsState) => {
    if (activeId) updateNoteTabs(activeId, change);
  }, [activeId, updateNoteTabs]);
  const [noteDetail, setNoteDetail] = useState<NoteDetail>(loadDetail);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState<{ sessionId: string; noteId: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEffect(() => { setDeleting(null); }, [activeId]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [rewrite, setRewrite] = useState<RewriteState | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const editorHandle = useRef<EditorHandle | null>(null);
  // The note page is the column's one scrolling body (PANES-SPEC §5).
  const bodyRef = useRef<HTMLDivElement>(null);
  useEdgeFade(bodyRef);
  const shareUnavailable = window.skaz.shareNote && window.skaz.platform === 'darwin'
    ? null : 'Available on macOS only';

  const allNotes = useMemo(
    () => sessionDetail?.notes_list ?? (sessionDetail?.notes ? [sessionDetail.notes] : []),
    [sessionDetail],
  );
  // The agent reads a confirmed snapshot taken at request time, so it does not need
  // the recording to stop; the one-pass generator still does.
  const capturing = !agentOn && (recorderState === 'recording' || recorderState === 'processing');
  // The server's answer when it gave one: the native summary never carries
  // segments, so their count would call every new recording empty.
  const hasSegments = sessionDetail?.has_transcript ?? (sessionDetail?.segments.length ?? 0) > 0;
  // Only once settings are actually loaded. An unread settings document must not
  // be reported as "no model chosen" — that would be a guess about the config.
  const notesModelMissing = codexOn
    ? !codexSettings?.notes_model || !codexSettings.notes_effort
    : !!settings && !settings.notes.model;

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
  //
  // Not while a session is loading: until its detail arrives the store still
  // holds the previous session's notes, and checking against those closed
  // every tab of the session just selected.
  useEffect(() => {
    if (!activeId || !sessionDetail || detailLoading) return;
    const known = new Set(allNotes.map((note) => note.id));
    setTabs((state) => pruneTabs(state, (tab) =>
      tab.sessionId !== activeId || tab.noteId === null || known.has(tab.noteId)));
  }, [activeId, sessionDetail, detailLoading, allNotes, setTabs]);

  const current: NoteTab | null = activeTabOf(tabs);
  const openNote: Note | null = current && current.sessionId === activeId && current.noteId && !detailLoading
    ? allNotes.find((note) => note.id === current.noteId) ?? null
    : null;
  const generating = generation?.status === 'running';
  // What the tab without a document is waiting on: this tab's own generation.
  const pending = current && !current.noteId && generation?.tabId === current.id ? generation : null;

  // Every reason generation is refused, stated on the control itself rather than
  // left as a dead button the user has to guess about.
  const codexBlock = codexOn ? connectionBlockOf(codexConnection)
    : apiBlock && !notesModelMissing ? { text: apiBlock, fix: 'settings' as const } : null;
  const generateHint = capturing
    ? 'Stop recording first'
    : !hasSegments ? 'No transcript'
    : codexBlock ? codexBlock.text
    : notesModelMissing ? 'No model selected' : null;
  const canGenerate = !!activeId && hasSegments && !capturing && !notesModelMissing && !codexBlock;

  const handleGenerate = useCallback(() => {
    void generate(noteDetail);
  }, [generate, noteDetail]);

  /** Retry inside the tab that failed, rather than stacking another one beside it. */
  const handleRetry = useCallback(() => {
    if (tabs.activeTabId) void generate(noteDetail, tabs.activeTabId);
  }, [generate, noteDetail, tabs.activeTabId]);

  const handleCreateEmpty = useCallback(async () => {
    if (!activeId) return;
    const note = await createEmptyNote();
    if (!note?.id) return;
    setTabs((state) => openTab(state, { sessionId: activeId, noteId: note.id!, title: 'Untitled' }));
  }, [activeId, createEmptyNote, setTabs]);

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
  }, [activeId, allNotes, renameNote, setTabs]);

  /** Delete the note a tab points at (decision 14) and close the tab with it. */
  const handleDeleteTab = useCallback((tab: NoteTab) => {
    if (tab.sessionId !== activeId || !tab.noteId) return;
    setDeleting({ sessionId: activeId, noteId: tab.noteId });
  }, [activeId]);

  /**
   * Send a note as a clean `.md` file through the system share sheet (spec §5-6).
   *
   * The open note is saved first and shared as it is on screen, so the recipient
   * never gets a version older than what the user sees. A background tab has no
   * pending edits: its stored text is already the latest.
   */
  const handleShareTab = useCallback(async (tab: NoteTab, x: number, y: number) => {
    if (tab.sessionId !== activeId || !tab.noteId) return;
    const stored = allNotes.find((note) => note.id === tab.noteId);
    if (!stored) return;
    const editor = editorHandle.current;
    const content = editor && editor.noteId === tab.noteId ? await editor.flush() : stored.content;
    const session = useStore.getState().sessions.find((s) => s.id === activeId);
    const shared = shareableNote({ title: stored.title, content }, session?.title ?? null);
    const ok = await window.skaz.shareNote?.({ ...shared, x, y });
    if (!ok) useStore.setState({ notesError: 'Could not open the Share menu' });
  }, [activeId, allNotes]);

  /**
   * A right click inside the document raises the app's own menu.
   *
   * The citation is resolved once, here, so every entry of the menu agrees about
   * whether this passage rests on stored speech: "Show in transcript" and
   * "Regenerate" are the same claim seen twice.
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

  /** Paste where the editor's selection is, through the editor itself. */
  const handlePaste = () => {
    const insert = menu?.insert;
    setMenu(null);
    if (!insert) return;
    void navigator.clipboard?.readText?.().then((text) => {
      if (text) insert(text);
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
      const preview = await new ApiClient(window.skaz)
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
      const saved = await new ApiClient(window.skaz)
        .applyRewrite(activeId, openNote.id, rewrite.previewId);
      useStore.setState((state) => state.activeSessionId !== activeId || !state.detail ? {} : {
        detail: { ...state.detail, notes: saved,
          notes_list: allNotes.map((note) => note.id === saved.id ? saved : note) },
      });
      setRewrite(null);
    } catch (error) {
      setRewrite((state) => state && {
        ...state, applying: false,
        error: error instanceof ApiError ? error.message : 'Could not apply the passage',
      });
    }
  }, [rewrite, openNote, activeId, allNotes]);

  const setRewriteError = (error: unknown) => {
    useStore.setState({
      notesError: error instanceof ApiError ? error.message : 'Could not regenerate the passage',
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
        onClick={handleGenerate}
      >
        <span>Create AI notes</span>
        {generateHint && <small>{generateHint}</small>}
      </button>
      <button
        type="button"
        className="btn btn--ghost notes__start-btn"
        disabled={!activeId}
        onClick={() => void handleCreateEmpty()}
      >
        <span>Create empty</span>
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
        onClose={(id) => { if (activeId) closeNoteTab(activeId, id); }}
        onRename={handleRenameTab}
        onDelete={handleDeleteTab}
        onShare={(tab, x, y) => void handleShareTab(tab, x, y)}
        shareUnavailable={shareUnavailable}
        onCreateEmpty={() => void handleCreateEmpty()}
        onCreateGenerated={handleGenerate}
        onOpenExisting={() => setPicking(true)}
        onDetailChange={(next) => {
          setNoteDetail(next);
          localStorage.setItem(DETAIL_KEY, next);
        }}
      />

      {/* Failures of actions without a tab of their own (create, rename,
          delete). A generation failure is reported inside its own tab. */}
      {error && <p className="notes__error" role="alert">{error}</p>}

      <div className="notes__body" ref={bodyRef}>
        {/* A tab with no note behind it is a generation in flight — or one that
            failed. Either way the user sees which tab it was, instead of a banner
            over the whole panel that cannot say. */}
        {current && !openNote && pending?.status === 'running' && (
          <div className="note-pending" role="status" aria-label="Generating notes">
            <span className="note-pending__spinner" aria-hidden="true" />
            {pending.taskId ? (
              <>
                <p>
                  {codexTask ? STATUS_LABEL[codexTask.status] : 'Starting'} · {codexOn ? 'Codex' : 'The agent'} is reading the whole recording
                  {codexTask?.activity.at(-1) ? ` · ${codexTask.activity.at(-1)}` : ''}
                </p>
                {codexTask && ['preparing', 'queued', 'running'].includes(codexTask.status) && (
                  <button type="button" className="btn btn--quiet"
                    onClick={() => void useCodex.getState().stop(codexTask.id)}>
                    {codexTask.status === 'running' ? 'Stop' : 'Cancel'}
                  </button>
                )}
                {codexTask && codexTask.activity.length > 0 && (
                  <details className="codex-task__journal">
                    <summary>Activity log · {codexTask.activity.length}</summary>
                    <ol>{codexTask.activity.map((entry, i) => <li key={i}>{entry}</li>)}</ol>
                  </details>
                )}
              </>
            ) : (
              <p>Reading the transcript and writing notes…</p>
            )}
          </div>
        )}

        {current && !openNote && pending?.status === 'failed' && (
          <div className="note-pending note-pending--failed">
            <p role="alert">{pending.error}</p>
            {codexTask?.answer && (
              <p className="codex-task__note">Partial text was not saved as a note: the notes are unfinished.</p>
            )}
            {codexTask && (codexTask.status === 'paused'
              || (codexTask.status === 'failed' && codexTask.engine !== 'api')) ? (
              <button type="button" className="btn btn--primary" onClick={() => {
                const sessionId = activeId;
                if (!sessionId) return;
                useStore.setState((s) => ({ noteGenerations: { ...s.noteGenerations,
                  [sessionId]: { ...pending, status: 'running', error: null } } }));
                void useCodex.getState().resume(codexTask.id).then(() => {
                  const failed = useCodex.getState().error;
                  if (failed) useStore.setState((s) => ({ noteGenerations: { ...s.noteGenerations,
                    [sessionId]: { ...pending, status: 'failed', error: failed } } }));
                });
              }}>
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canGenerate || generating}
                onClick={handleRetry}
              >
                Retry
              </button>
            )}
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
              onDelete={(note) => activeId && setDeleting({ sessionId: activeId, noteId: note.id! })}
            />
            {/* The icon, heading and hint only explain a pane that shows nothing.
                Above an actual list they are noise that pushes the notes down, so
                once there is a list only the two start buttons remain. */}
            {/* No illustration and no heading (docs/NOTES-POLISH-SPEC.md §6): one
                quiet line where the list would be, then the same two buttons. */}
            {allNotes.length === 0 && <p className="notes__empty">No notes yet</p>}
            <div className="notes__start">{startButtons}</div>
            {codexBlock && (
              <CodexConnectionNotice block={codexBlock} text={codexBlock.text}
                settingsLabel={codexOn ? 'Open Codex settings' : 'Open Notes settings'}
                onOpenSettings={() => openSettings('notes')} />
            )}
            {!codexBlock && notesModelMissing && (
              <SetupNotice
                message={codexOn ? 'No Codex model selected for notes.' : 'No model selected for notes.'}
                section="notes"
              />
            )}
          </>
        )}

        {openNote && current && activeId && (
          <div className="notes__page">
            <NoteEditor
              key={`${activeId}:${openNote.id}`}
              sessionId={activeId}
              note={openNote}
              onStatusChange={setSaveStatus}
              onHandle={(handle) => { editorHandle.current = handle; }}
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
          label="Passage actions"
          onDismiss={() => setMenu(null)}
        >
          <ContextMenuItem
            disabled={!menu.citation}
            hint={menu.text ? 'Source not found' : 'Nothing selected'}
            onClick={() => {
              if (!menu.citation) return;
              onCite(menu.citation);
              setMenu(null);
            }}
          >
            Show in transcript
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menu.text}
            hint="Nothing selected"
            onClick={() => {
              setAskContext({ text: menu.text, citation: menu.citation });
              setMenu(null);
            }}
          >
            Ask
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menu.citation || !menu.span || rewriting}
            hint={!menu.text ? 'Nothing selected'
              : !menu.citation ? 'Source not found'
              : !menu.span ? 'Passage not found in the text' : 'Regenerating'}
            onClick={() => void handleRewrite()}
          >
            Regenerate
          </ContextMenuItem>
          <ContextMenuItem disabled={!menu.text} hint="Nothing selected" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </ContextMenuItem>
          <ContextMenuItem onClick={handlePaste}>Paste</ContextMenuItem>
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

      {deleting && deleting.sessionId === activeId && (
        <SessionDialog title="Delete notes permanently?" busy={deleteBusy} onClose={() => setDeleting(null)}>
          <p>The notes will be deleted and cannot be restored. There is no trash.</p>
          <div className="session-dialog__actions">
            <button className="btn btn--quiet" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn btn--primary" disabled={deleteBusy} onClick={() => {
              const target = deleting;
              setDeleteBusy(true);
              void deleteNote(target.noteId).then((deleted) => {
                if (deleted) {
                  for (const tab of tabs.tabs) {
                    if (tab.noteId === target.noteId) closeNoteTab(target.sessionId, tab.id);
                  }
                  setDeleting(null);
                }
              }).finally(() => setDeleteBusy(false));
            }}>Delete permanently</button>
          </div>
        </SessionDialog>
      )}
      {picking && (
        <OpenNoteDialog
          notes={allNotes}
          onClose={() => setPicking(false)}
          onPick={(note) => {
            setPicking(false);
            if (!activeId) return;
            setTabs((state) => openTab(state, {
              sessionId: activeId, noteId: note.id!, title: noteName(note),
            }));
          }}
        />
      )}
    </div>
  );
}
