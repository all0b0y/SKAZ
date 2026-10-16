"""SKAZ's Hermes must never repoint the user's own ``hermes`` command (final review C1).

Why it happened (Hermes v0.21.5+6627.g4bb9e57, source in ``~/.hermes/hermes-agent``):

* ``hermes_constants.py:216-233`` ``get_default_hermes_root``: a ``HERMES_HOME``
  outside ``~/.hermes`` becomes Hermes' *root* (line 231).
* ``pm/environments.py:115-140`` ``store_root``: ``HERMES_RUNTIME_DIR`` wins
  (lines 117-119); otherwise the install stamp's ``runtimeDir``, else
  ``<root>/tools`` (line 140) — i.e. ``<SKAZ data>/agents/hermes-home/tools``.
* ``hermes_cli/venv_sync.py:338-436`` ``prepare_launch`` runs at every start: a
  store that is not current is synced (the ~1.5 GB "first start") and
  ``publish_launchers`` (``venv_sync.py:68-99``, called at line 429) →
  ``_launchers.ensure_install_launchers`` (``_launchers.py:391``) →
  ``stage_launcher`` (``_launchers.py:374``) mints ``<install>/.hermes/bin/hermes``
  bound to ``resolve_store_python`` (``_launchers.py:103``, ``store_root``): the
  user's shared launcher then runs SKAZ's Python; ``expose_cli``
  (``_launchers.py:409-466``) refreshes ``~/.local/bin`` forwarders.

What SKAZ relies on: the supported override ``HERMES_RUNTIME_DIR`` — "a
process-local development override. It makes the bootstrap and PM use the same
writable store" (``website/docs/reference/package-management.md:247-267``; read
by ``pm/environments.py:117``). SKAZ sets it to the store the user's own
launcher already runs, so nothing is synced, no store appears under SKAZ's
folder, and a re-minted launcher equals the existing one byte for byte
(``_launchers._write_shell``, lines 308-313, leaves an identical file alone).

Safety net (:class:`LauncherWatch`): every SKAZ invocation of Hermes snapshots the
launcher files first and compares afterwards. A launcher that now points into
SKAZ's folder is put back; any change during a SKAZ-folder invocation, and a
tool store that appeared in SKAZ's Hermes folder, stop the action with a plain
reason.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import shutil
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..install.errors import StepRefused

LAUNCHER_NAMES = ("hermes", "hermes-acp", "hermes-agent")
_MAX_LAUNCHER_BYTES = 256 * 1024
#: ``_launchers._launcher_script`` line 285: ``sys.path.insert(0, '<install>')``.
_BOOTSTRAP = re.compile(r"sys\.path\.insert\(0, (['\"])(?P<root>[^'\"]+)\1\)")

TAMPERED = ("Hermes tried to change your own `hermes` command while SKAZ was using it. "
            "SKAZ put it back and stopped. Update Hermes, then try again.")
NOT_RESTORED = ("Hermes changed your own `hermes` command while SKAZ was using it, and SKAZ couldn't put "
                "it back. Reinstall Hermes to repair it.")
CHANGED = "Your `hermes` command changed while SKAZ was using Hermes, so SKAZ stopped. Try again."
STORE_CREATED = ("Hermes started installing its tools into SKAZ's folder instead of using your installation, "
                 "so SKAZ stopped it and removed them. Update Hermes, then try again.")
TAINTED = ("Your own `hermes` command points into SKAZ's folder (left by an earlier SKAZ version). "
           "Reinstall Hermes to repair it; SKAZ won't start Hermes until then.")


class LauncherTampered(StepRefused):
    """A Hermes invocation changed (or found changed) the user's launchers; the action is refused."""


def _tokens(path: Path) -> list[str]:
    """Shell words of a small launcher script; nothing for binaries, big or unreadable files."""
    try:
        if path.stat().st_size > _MAX_LAUNCHER_BYTES:
            return []
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return []
    try:
        return shlex.split(text, comments=True)
    except ValueError:
        return []


def _bootstrap_root(tokens: Sequence[str]) -> Path | None:
    for token in tokens:
        match = _BOOTSTRAP.search(token)
        if match:
            return Path(match["root"])
    return None


def install_root(binary: Path, user_home: Path) -> Path | None:
    """Hermes checkout behind ``binary`` (``~/.local/bin/hermes`` forwards to ``<install>/.hermes/bin/``)."""
    current, seen = binary, set[Path]()
    for _ in range(4):
        real = Path(os.path.realpath(current))
        tokens = _tokens(real)
        root = _bootstrap_root(tokens)
        if root is not None:
            return root
        if real.parent.name == "bin" and real.parent.parent.name == ".hermes" \
                and (real.parent.parent.parent / "pyproject.toml").is_file():
            return real.parent.parent.parent
        forward = next((Path(token) for token in tokens
                        if token.endswith(("/.hermes/bin/hermes", "/.hermes/bin/hermes-acp"))), None)
        if forward is None or forward in seen:
            break
        seen.add(forward)
        current = forward
    default = user_home / ".hermes" / "hermes-agent"
    return default if (default / ".hermes" / "bin" / "hermes").exists() else None


def _launcher_store(root: Path) -> Path | None:
    """The store whose Python the install's own launcher runs (``exec <store>/<python>/bin/python3``)."""
    tokens = _tokens(root / ".hermes" / "bin" / "hermes")
    if "exec" not in tokens or tokens.index("exec") + 1 >= len(tokens):
        return None
    python = Path(tokens[tokens.index("exec") + 1])
    return next((parent for parent in python.parents if (parent / "facts.json").is_file()), None)


def _stamped_store(root: Path, user_home: Path) -> Path:
    """``pm/environments.store_root`` (lines 120-140) for the user's default home, no override."""
    default = user_home / ".hermes" / "tools"
    manifest_path = root.parent / "manifest.json"
    with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        if (root.parent / str(manifest.get("repo", ""))).resolve() == root.resolve():
            return (root.parent / str(manifest["store"])).resolve()
    for directory in (root, *root.parents):
        stamp = directory / "install-stamp.json"
        if stamp.is_file():
            try:
                data = json.loads(stamp.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                return default
            value = data.get("runtimeDir") if isinstance(data, dict) else None
            return Path(value) if isinstance(value, str) and value else default
    return default


def user_store(binary: Path, user_home: Path) -> Path:
    """The tool store the user's own ``hermes`` uses; SKAZ passes it as ``HERMES_RUNTIME_DIR``."""
    root = install_root(binary, user_home)
    if root is None:
        return user_home / ".hermes" / "tools"
    return _launcher_store(root) or _stamped_store(root, user_home)


def launcher_files(binary: Path, user_home: Path, *, system_bins: Iterable[Path] = ()) -> list[Path]:
    """Every launcher Hermes may (re)publish: the install's own, the PATH forwarders, the located binary."""
    files: list[Path] = [binary]
    root = install_root(binary, user_home)
    if root is not None:
        files += [root / ".hermes" / "bin" / name for name in LAUNCHER_NAMES[:2]]
    for directory in (user_home / ".local" / "bin", user_home / ".hermes" / "bin", *system_bins):
        files += [directory / name for name in LAUNCHER_NAMES]
    return list(dict.fromkeys(files))


@dataclass(frozen=True)
class _State:
    link: str | None
    data: bytes | None
    mode: int | None


def _state(path: Path) -> _State:
    try:
        if path.is_symlink():
            return _State(os.readlink(path), None, None)
        if not path.is_file():
            return _State(None, None, None)
        return _State(None, path.read_bytes(), path.stat().st_mode & 0o7777)
    except OSError:
        return _State(None, None, None)


def _mentions(state: _State, markers: Sequence[str]) -> bool:
    if state.link is not None:
        return any(marker in state.link for marker in markers)
    if state.data is None:
        return False
    text = state.data.decode("utf-8", errors="replace")
    return any(marker in text for marker in markers)


def _restore(path: Path, state: _State) -> bool:
    try:
        if state.link is not None:
            temporary = path.with_name(f".{path.name}.skaz-restore")
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
            temporary.symlink_to(state.link)
            os.replace(temporary, path)
        elif state.data is not None:
            temporary = path.with_name(f".{path.name}.skaz-restore")
            temporary.write_bytes(state.data)
            os.chmod(temporary, state.mode or 0o755)
            os.replace(temporary, path)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        return False
    return True


class LauncherWatch:
    """Snapshot of the user's Hermes launchers around one SKAZ invocation of Hermes.

    ``strict`` (SKAZ's own Hermes folder): any change refuses the action. Otherwise (the
    official installer/updater in the user's environment, which legitimately republishes
    launchers) only a launcher that now points into SKAZ's folder does.
    """

    def __init__(self, files: Iterable[Path], *, skaz_dirs: Iterable[Path], stores: Iterable[Path] = (),
                 strict: bool = True) -> None:
        self._files = list(dict.fromkeys(files))
        markers: list[str] = []
        for directory in skaz_dirs:
            markers += [str(directory), str(directory.resolve())]
        self._markers = tuple(dict.fromkeys(markers))
        self._stores = [store for store in dict.fromkeys(stores) if not store.exists()]
        self._strict = strict
        self._before = {path: _state(path) for path in self._files}

    def tainted(self) -> list[Path]:
        """Launchers that already point into SKAZ's folder (an earlier version's damage)."""
        return [path for path, state in self._before.items() if _mentions(state, self._markers)]

    def refuse_if_tainted(self) -> None:
        if self.tainted():
            raise LauncherTampered(TAINTED)

    def check(self) -> None:
        """After the invocation: put back what points into SKAZ, raise if anything was off."""
        created = [store for store in self._stores if store.exists()]
        for store in created:
            shutil.rmtree(store, ignore_errors=True)
        changed = {path: now for path in self._files if (now := _state(path)) != self._before[path]}
        ours = [path for path, now in changed.items() if _mentions(now, self._markers)]
        failed = [path for path in ours if not _restore(path, self._before[path])]
        if failed:
            raise LauncherTampered(NOT_RESTORED)
        if ours:
            raise LauncherTampered(TAMPERED)
        if created:
            raise LauncherTampered(STORE_CREATED)
        if changed and self._strict:
            raise LauncherTampered(CHANGED)
