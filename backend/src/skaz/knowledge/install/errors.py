"""Plain-words reasons for a failed installation (B2a): no network, no space, needs Node/Python, no rights."""
from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Protocol

_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"no space left|ENOSPC|disk (is )?full|not enough (free )?space", re.I),
     "There is not enough free disk space. Free some space and try again."),
    (re.compile(r"could not resolve host|curl: \(6\)|curl: \(7\)|failed to connect|network is unreachable|"
                r"connection (timed out|refused|reset)|temporary failure in name resolution|ENOTFOUND|"
                r"EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|SSL_ERROR|curl: \(28\)|curl: \(35\)|curl: \(56\)", re.I),
     "SKAZ couldn't download the installer. Check the internet connection and try again."),
    (re.compile(r"(node|npm|npx): (command )?not found|requires node|node\.js \d+ or (later|newer)|"
                r"EBADENGINE", re.I),
     "This installer needs Node.js. Install Node.js, then try again."),
    (re.compile(r"python3?: (command )?not found|requires python|no suitable python|python \d\.\d+ or newer",
                re.I),
     "This installer needs Python. Install Python 3, then try again."),
    (re.compile(r"permission denied|EACCES|operation not permitted|EPERM|read-only file system|"
                r"administrator rights|a terminal is required to read the password|sudo", re.I),
     "The installer has no permission to write where it needs to. SKAZ installs only into your home "
     "folder and never asks for administrator rights; install manually if your setup needs that."),
    (re.compile(r"curl: \(22\)|HTTP error 40\d|404 Not Found|403 Forbidden", re.I),
     "The installer download was refused. Try again later or install manually."),
)


class StepRefused(Exception):
    """A step must not run, or its result must not count; the message is the plain reason shown."""


#: Optional check around one installer step (e.g. Hermes launchers): ``check()`` raises ``StepRefused``.
class StepWatch(Protocol):
    def check(self) -> None: ...


def failure_reason(lines: Sequence[str], exit_code: int | None) -> str:
    """The first matching plain reason, newest log lines first; a generic one otherwise."""
    for line in reversed(lines[-200:]):
        for pattern, reason in _RULES:
            if pattern.search(line):
                return reason
    if exit_code is None:
        return "The installer stopped unexpectedly."
    return f"The installer stopped with an error (exit code {exit_code}). See the log, or install manually."
