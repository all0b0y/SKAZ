"""Claude Code's own folder in SKAZ and its live chat sessions (N6 decisions 9, 11, 14).

Claude Code runs with ``CLAUDE_CONFIG_DIR`` = ``<work_root>/config``, a folder only SKAZ uses: its own
sign-in (``claude auth login`` there), its own settings and the transcripts of SKAZ's chats. The
user's ``~/.claude`` is never read or written.

Where the sign-in is kept (read from the installed 2.1.281 binary, offline): with ``CLAUDE_CONFIG_DIR``
set, Claude Code stores its OAuth credentials in the macOS login keychain as a generic password with
the service ``Claude Code-credentials-<first 8 hex of sha256(NFC(config dir))>`` and the account
``$USER`` — written and read by Claude Code itself through ``/usr/bin/security`` (not by SKAZ), and as
``<config dir>/.credentials.json`` (0600) only where the keychain can't be written. So the item is
tied to this folder's path, not to the SKAZ app's signature; whether it survives a restart of the
unsigned SKAZ build is still to be checked by hand (see the N6 report).

A live session (one per chat) is a Claude Code "project" of its own: its working folder is
``<work_root>/sessions/<session id>`` (empty; the run has no file tools), so Claude Code keeps the
transcript under ``config/projects/<that folder, sanitized>/<session id>.jsonl``. Deleting a session
is Claude Code's own ``claude project purge <folder> --yes`` (2.1.281: transcripts and their memory
folder, task lists, debug log, file history, the ``.claude.json`` project entry, prompt-history lines)
with SKAZ's ``CLAUDE_CONFIG_DIR``, then SKAZ removes its own copies. The instructions a session
started with are kept next to it (``prompts/<session id>.txt``) and used for every later turn, so a
session's system prompt never changes mid-session (N6 contract §2 rule 1).
"""
from __future__ import annotations

import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

#: ``claude project purge`` when the folder has no Claude Code state (2.1.281 ``purgeProjectHandler``):
#: the session is already gone.
NOTHING_TO_PURGE = "No Claude Code project state found"
#: Seconds one ``claude project purge`` may take.
PURGE_TIMEOUT_S = 30.0
#: The start-up sweep leaves a session whose files changed within this many seconds (it may be starting).
SWEEP_MIN_AGE_S = 600.0
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def is_session_id(value: str) -> bool:
    """A session id SKAZ minted (a lowercase UUID): anything else is never turned into a path."""
    return bool(_UUID.match(value))


def new_session_id() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True)
class ClaudeFolder:
    """SKAZ's Claude Code folder: ``config`` (``CLAUDE_CONFIG_DIR``), session folders and prompts."""

    root: Path

    @property
    def config_dir(self) -> Path:
        return self.root / "config"

    def prepare(self) -> Path:
        """The ``CLAUDE_CONFIG_DIR``, created private (0700) on first use."""
        self.config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        return self.config_dir

    def session_dir(self, session_id: str) -> Path:
        if not is_session_id(session_id):
            raise ValueError("Not a Claude Code session of SKAZ.")
        return self.root / "sessions" / session_id

    def prompt_file(self, session_id: str) -> Path:
        if not is_session_id(session_id):
            raise ValueError("Not a Claude Code session of SKAZ.")
        return self.root / "prompts" / f"{session_id}.txt"

    def open_session(self, session_id: str) -> Path:
        """The session's working folder (created 0700 if missing; Claude Code keys the transcript by it)."""
        folder = self.session_dir(session_id)
        folder.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        folder.mkdir(mode=0o700, exist_ok=True)
        return folder

    def save_prompt(self, session_id: str, text: str) -> Path:
        """The instructions a new session starts with, kept for its later turns (0600)."""
        path = self.prompt_file(session_id)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def prompt(self, session_id: str) -> Path | None:
        path = self.prompt_file(session_id)
        return path if path.is_file() else None

    def leftovers(self, session_id: str) -> list[Path]:
        """Files of this session still in ``config/projects`` (``<id>.jsonl`` and its ``<id>/`` folder)."""
        projects = self.config_dir / "projects"
        if not is_session_id(session_id) or not projects.is_dir():
            return []
        found: list[Path] = []
        for project in projects.iterdir():
            if project.is_dir() and not project.is_symlink():
                found += [entry for entry in project.iterdir()
                          if entry.name in (f"{session_id}.jsonl", session_id)]
        return found

    def remove_local(self, session_id: str) -> None:
        """SKAZ's own files of a session (its working folder, its prompt) and any transcript left behind.
        Raises ``OSError`` when something stays."""
        for path in (self.session_dir(session_id), self.prompt_file(session_id), *self.leftovers(session_id)):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            elif path.exists() or path.is_symlink():
                path.unlink()

    def local_sessions(self, older_than_s: float = SWEEP_MIN_AGE_S) -> list[str]:
        """Ids of the sessions with SKAZ files here (``prompts/<id>.txt``, ``sessions/<id>``) none of
        which changed within ``older_than_s`` (newer ones may belong to a session starting now)."""
        newest: dict[str, float] = {}
        for folder, suffix in ((self.root / "prompts", ".txt"), (self.root / "sessions", "")):
            if not folder.is_dir():
                continue
            for entry in folder.iterdir():
                name = entry.name[: -len(suffix)] if suffix and entry.name.endswith(suffix) else entry.name
                if not is_session_id(name) or entry.is_symlink():
                    continue
                try:
                    changed = entry.stat().st_mtime
                except OSError:
                    continue
                newest[name] = max(newest.get(name, 0.0), changed)
        cutoff = time.time() - older_than_s
        return sorted(name for name, changed in newest.items() if changed < cutoff)
