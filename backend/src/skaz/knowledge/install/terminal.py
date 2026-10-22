"""Open an agent's own sign-in/setup flow in the user's Terminal.

SKAZ never sees credentials: it writes a small ``.command`` script that runs
the agent's official command (``claude auth login``, ``hermes model``) and asks
macOS to open it in Terminal. The user talks to the agent directly; SKAZ does
not read the script's output, the browser page or the stored tokens.

Every script leaves its exit code in a ``.done`` file when it ends (SKAZ watches it and checks the
agent at once). The window then speaks English: after success it says so and closes itself; after an
error it stays open until Return. Closing is done from inside the window with Terminal's own
AppleScript — only a one-tab window whose shell has ended, found by this tab's tty — so the user's
Terminal settings are never changed (checked by hand on macOS 26.6.2, 2026-10-21: the window
closes without a "terminate processes?" question and without an automation prompt).
"""
from __future__ import annotations

import asyncio
import os
import shlex
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Literal

from .system import refuse_sudo

#: Runs the opener command (``open -a Terminal <script>``); replaced in tests.
Opener = Callable[[Sequence[str]], Awaitable[None]]

#: What a successful window prints before it closes itself.
SIGNED_IN_NOTE = "Sign-in finished. SKAZ is checking it now."
#: What a window that shows something prints when it is done (it waits for Return).
KEEP_OPEN_NOTE = "Done. Press Return to close this window."
#: Exit code left when the window was closed before the agent finished (SIGHUP).
CLOSED_EARLY = 129
#: Terminal's AppleScript that closes the window of one tty (written next to the scripts).
CLOSER_FILE = "close-window.applescript"

_CLOSER = """\
-- Written by SKAZ. Closes the Terminal window SKAZ opened, once its shell has ended.
-- Only a window with this one tab (found by its tty) and no running process; nothing else.
on run argv
\tset target to item 1 of argv
\ttell application "Terminal"
\t\trepeat 80 times
\t\t\tset found to false
\t\t\trepeat with w in windows
\t\t\t\tset ts to tabs of w
\t\t\t\trepeat with t in ts
\t\t\t\t\tif tty of t is target then
\t\t\t\t\t\tset found to true
\t\t\t\t\t\tif (count of ts) > 1 then return
\t\t\t\t\t\tif busy of t is false then
\t\t\t\t\t\t\tclose w
\t\t\t\t\t\t\treturn
\t\t\t\t\t\tend if
\t\t\t\t\tend if
\t\t\t\tend repeat
\t\t\tend repeat
\t\t\tif not found then return
\t\t\tdelay 0.25
\t\tend repeat
\tend tell
end run
"""


def stopped_note(agent: str) -> str:
    """What a window prints when the agent's command ended with an error (it stays open)."""
    return f"{agent} stopped before it finished. Press Return to close this window."


async def macos_open(argv: Sequence[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    async with asyncio.timeout(15):
        code = await process.wait()
    if code != 0:
        raise OSError("macOS could not open Terminal.")


def done_path(directory: Path, name: str) -> Path:
    """Where a step script leaves its exit code when it ends (read by SKAZ, holds only a number)."""
    return directory / f"{name}.done"


def _write_atomic(path: Path, text: str, mode: int) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def write_steps(directory: Path, name: str, title: str, commands: Sequence[Sequence[str]],
                env: Mapping[str, str], *, agent: str = "The agent", close_on_success: bool = True,
                done_note: str = SIGNED_IN_NOTE) -> Path:
    """One or more commands joined with ``&&`` (a later one runs only if the earlier ones worked);
    when they end the script writes their exit code to :func:`done_path` and says what happened in
    English. ``close_on_success``: the window closes itself after success (else it waits for Return,
    for a window that only shows something)."""
    if not commands:
        raise ValueError("No command to run.")
    for argv in commands:
        refuse_sudo(argv)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    closer = directory / CLOSER_FILE
    _write_atomic(closer, _CLOSER, 0o600)
    done = done_path(directory, name)
    done.unlink(missing_ok=True)
    joined = " && ".join(shlex.join(argv) for argv in commands)
    target, staging = shlex.quote(str(done)), shlex.quote(str(done) + ".tmp")
    lines = ["#!/bin/bash",
             "# Written by SKAZ. Runs the agent's own commands; SKAZ does not read their output."]
    lines += [f"export {key}={shlex.quote(value)}" for key, value in sorted(env.items())]
    lines += [
        f"skaz_done() {{ printf '%s\\n' \"$1\" > {staging} && mv {staging} {target}; }}",
        # Only a real Terminal tab closes itself; detached, so the tab is idle when it is closed.
        "skaz_close() {",
        '  if [ -t 0 ] && [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]; then',
        "    /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /usr/bin/osascript "
        f'{shlex.quote(str(closer))} "$(tty)" </dev/null >/dev/null 2>&1 &',
        "  fi",
        "}",
        f"trap 'skaz_done {CLOSED_EARLY}; exit {CLOSED_EARLY}' HUP",
        "clear", f"echo {shlex.quote(title)}", "echo", f"echo {shlex.quote(joined)}", "echo",
        joined,
        "status=$?",
        'skaz_done "$status"',
        # From here the code is written: closing the window no longer changes it.
        "trap 'exit \"$status\"' HUP",
        "echo",
        'if [ "$status" -eq 0 ]; then',
    ]
    if close_on_success:
        lines += [f"  echo {shlex.quote(done_note)}", "  sleep 2", "  skaz_close", "  exit 0"]
    else:
        lines += [f"  echo {shlex.quote(KEEP_OPEN_NOTE)}", "  read -r _", "  skaz_close", "  exit 0"]
    lines += ["fi",
              f"echo {shlex.quote(stopped_note(agent))}",
              "read -r _",
              "skaz_close",
              'exit "$status"']
    path = directory / f"{name}.command"
    _write_atomic(path, "\n".join(lines) + "\n", 0o700)
    return path


def progress_of(code: int | None, started: bool) -> Literal["waiting", "done", "failed"] | None:
    """A window's progress from its exit code: ``None`` when SKAZ never opened it."""
    if not started:
        return None
    return "waiting" if code is None else "done" if code == 0 else "failed"


def terminal_progress(launcher: TerminalLauncher, name: str) -> Literal["waiting", "done", "failed"] | None:
    return progress_of(launcher.finished(name), launcher.started(name))


def read_done(directory: Path, name: str) -> int | None:
    """The exit code a step script left, or ``None`` while it runs (or if it never ran)."""
    try:
        text = done_path(directory, name).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.lstrip("-").isdigit() else None


class TerminalLauncher:
    def __init__(self, directory: Path, *, opener: Opener = macos_open) -> None:
        self.directory = directory
        self._opener = opener

    async def open(self, name: str, title: str, argv: Sequence[str], env: Mapping[str, str], *,
                   agent: str = "The agent") -> Path:
        """One agent command (its sign-in or setup); its end is watched like :meth:`open_steps`."""
        return await self.open_steps(name, title, [argv], env, agent=agent)

    async def open_steps(self, name: str, title: str, commands: Sequence[Sequence[str]],
                         env: Mapping[str, str], *, agent: str = "The agent", close_on_success: bool = True,
                         done_note: str = SIGNED_IN_NOTE) -> Path:
        script = write_steps(self.directory, name, title, commands, env, agent=agent,
                             close_on_success=close_on_success, done_note=done_note)
        await self._opener(["/usr/bin/open", "-a", "Terminal", str(script)])
        return script

    def finished(self, name: str) -> int | None:
        return read_done(self.directory, name)

    def started(self, name: str) -> bool:
        """A script of this name was written (it may still run, or have ended)."""
        return (self.directory / f"{name}.command").exists()
