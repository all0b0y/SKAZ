"""«Я» at rest: one Fernet-encrypted file beside the provider keys (decision 5, layer 3).

The same approach as ``skaz.secrets.FileSecretStore`` — its own files in the same private folder
(``<data>/secrets``, 0700): ``me.json.enc`` (0600) and its key ``me.key`` (0600). The whole «Я»
(skills, versions, edits) is one encrypted blob, so not even skill titles are readable on disk.
Writes go through a private temp file and an atomic rename.

Known limit (shown in Settings): the key sits next to the ciphertext, so the real boundary is the
file permissions — a program running as the same macOS user that targets SKAZ could read it.

An unreadable file (lost key, damage) is never overwritten silently: it is moved aside to
``me.json.enc.unreadable`` before the next write, and «Я» starts empty.
"""
from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

VAULT_NAME = "me.json.enc"
KEY_NAME = "me.key"
UNREADABLE_SUFFIX = ".unreadable"


class MeVault:
    def __init__(self, directory: Path | str) -> None:
        self.dir = Path(directory)
        self.path = self.dir / VAULT_NAME
        self.key_path = self.dir / KEY_NAME
        self._unreadable = False

    def _ensure_dir(self) -> None:
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            log.warning("Could not restrict permissions on the secret directory.")

    def _fernet(self, *, create: bool) -> Any:
        from cryptography.fernet import Fernet

        if not self.key_path.exists():
            if not create:
                return None
            self._ensure_dir()
            key = Fernet.generate_key()
            try:
                descriptor = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass  # made meanwhile by another writer: use theirs
            else:
                try:
                    os.write(descriptor, key)
                finally:
                    os.close(descriptor)
        try:
            os.chmod(self.key_path, 0o600)
        except OSError:
            log.warning("Could not restrict permissions on the Me key file.")
        return Fernet(self.key_path.read_bytes().strip())

    def read(self) -> dict[str, Any] | None:
        """The stored «Я», or ``None`` when there is none (or it can't be read — never logged)."""
        from cryptography.fernet import InvalidToken

        if not self.path.exists():
            return None
        try:
            blob = self.path.read_bytes()
            fernet = self._fernet(create=False)
            if not blob or fernet is None:
                raise ValueError("no key")
            loaded = json.loads(fernet.decrypt(blob))
        except (InvalidToken, ValueError, OSError):
            log.warning("The stored Me profile could not be read; starting empty (the file is kept aside).")
            self._unreadable = True
            return None
        if not isinstance(loaded, dict):
            self._unreadable = True
            return None
        return loaded

    def write(self, data: dict[str, Any]) -> None:
        self._ensure_dir()
        if self._unreadable and self.path.exists():
            os.replace(self.path, self.path.with_name(VAULT_NAME + UNREADABLE_SUFFIX))
        self._unreadable = False
        token = self._fernet(create=True).encrypt(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        descriptor, temp_name = tempfile.mkstemp(dir=self.dir, prefix=".me-", suffix=".tmp")
        try:
            os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(token)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            log.warning("Could not restrict permissions on the stored Me profile.")

    def erase(self) -> None:
        """"Delete everything": the file, a kept-aside unreadable copy and the key."""
        for path in (self.path, self.path.with_name(VAULT_NAME + UNREADABLE_SUFFIX), self.key_path):
            path.unlink(missing_ok=True)
        self._unreadable = False
