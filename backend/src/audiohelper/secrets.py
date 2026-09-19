"""Provider API keys.

Keys live in an encrypted file inside the application's own data directory, or
in the process environment for CI/headless use. They are never written to the
database, the API responses or the logs.

Why not the OS keychain: a keychain item's ACL is bound to the binary that
created it. The shipped SKAZ bundle is not signed with a Developer ID, so it
cannot own stable keychain items — the keychain refused to unlock for the
packaged backend (``KeyringLocked``) and provider keys silently failed to
persist across restarts. The file vault has no such dependency and behaves the
same whether the backend runs from the repo or from inside the bundle.

Known limitation: the encryption key sits next to the ciphertext, so the real
boundary is POSIX file permissions (0600 file, 0700 directory). This protects
keys in backups, synced folders and stray copies; it does not protect against
another process already running as the same user.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

SERVICE_NAME = "SKAZ"

#: Environment variables accepted as a source for a provider key. Read only in an
#: explicit development/CI run (see ``env_fallback_enabled``); a normal desktop run
#: never picks a credential up from the ambient environment.
ENV_VARS: Mapping[str, tuple[str, ...]] = {
    "openrouter": ("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "soniox": ("SONIOX_API_KEY",),
}

#: Opt-in switch for the environment fallback above.
ENV_FALLBACK_FLAG = "AUDIOHELPER_ALLOW_ENV_KEYS"

#: Serialises read-modify-write cycles; two writers would drop each other's keys.
_VAULT_LOCK = threading.Lock()


def service_name(provider: str) -> str:
    """Per-provider label, kept for log and diagnostic identity."""
    return f"{SERVICE_NAME}:{provider}"


def env_fallback_enabled(env: Mapping[str, str] | None = None) -> bool:
    source = os.environ if env is None else env
    return source.get(ENV_FALLBACK_FLAG, "").strip().lower() in {"1", "true", "yes", "on"}


class SecretStore(Protocol):
    """Provider-name keyed secret storage."""

    def get(self, provider: str) -> str | None: ...

    def set(self, provider: str, value: str) -> None: ...

    def delete(self, provider: str) -> None: ...


class MemorySecretStore:
    """In-process store; used by tests and by `--no-keyring` runs."""

    def __init__(self, initial: Mapping[str, str] | None = None) -> None:
        self._values: dict[str, str] = dict(initial or {})

    def get(self, provider: str) -> str | None:
        return self._values.get(provider)

    def set(self, provider: str, value: str) -> None:
        self._values[provider] = value

    def delete(self, provider: str) -> None:
        self._values.pop(provider, None)


class FileSecretStore:
    """Encrypted per-installation key file with a read-only environment fallback.

    The whole provider map is encrypted as a single blob, so provider names are
    not readable either. Reads tolerate a corrupt or foreign file: an unreadable
    vault degrades to "no keys configured", never to a backend that will not
    start.
    """

    def __init__(self, directory: Path | str, *, env: Mapping[str, str] | None = None) -> None:
        self._dir = Path(directory)
        self._vault_path = self._dir / "secrets.json.enc"
        self._key_path = self._dir / "secrets.key"
        self._env = os.environ if env is None else env

    # -- crypto ------------------------------------------------------------

    def _ensure_dir(self) -> None:
        self._dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self._dir, 0o700)
        except OSError:
            logger.warning("Could not restrict permissions on the secret directory.")

    def _fernet(self) -> Any:
        from cryptography.fernet import Fernet

        self._ensure_dir()
        if self._key_path.exists():
            key = self._key_path.read_bytes().strip()
        else:
            key = Fernet.generate_key()
            # O_EXCL: a concurrent writer must not have its key silently replaced.
            descriptor = os.open(self._key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(descriptor, key)
            finally:
                os.close(descriptor)
        try:
            os.chmod(self._key_path, 0o600)
        except OSError:
            logger.warning("Could not restrict permissions on the secret key file.")
        return Fernet(key)

    # -- persistence -------------------------------------------------------

    def _read_all(self) -> dict[str, str]:
        from cryptography.fernet import InvalidToken

        if not self._vault_path.exists():
            return {}
        blob = self._vault_path.read_bytes()
        if not blob:
            return {}
        try:
            loaded = json.loads(self._fernet().decrypt(blob))
        except (InvalidToken, ValueError, OSError):
            # Never log the payload: it is unusable here and must not leak.
            logger.warning("Stored provider keys could not be read; treating them as unset.")
            return {}
        if not isinstance(loaded, dict):
            return {}
        return {k: v for k, v in loaded.items() if isinstance(k, str) and isinstance(v, str)}

    def _write_all(self, values: Mapping[str, str]) -> None:
        self._ensure_dir()
        token = self._fernet().encrypt(json.dumps(dict(values)).encode("utf-8"))
        # Write through a private temp file in the same directory: a crash cannot
        # leave a half-written vault, and the secret is never briefly readable by
        # anyone else.
        descriptor, temp_name = tempfile.mkstemp(dir=self._dir, prefix=".secrets-", suffix=".tmp")
        try:
            os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(token)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self._vault_path)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        try:
            os.chmod(self._vault_path, 0o600)
        except OSError:
            logger.warning("Could not restrict permissions on the stored provider keys.")

    # -- SecretStore -------------------------------------------------------

    def get(self, provider: str) -> str | None:
        with _VAULT_LOCK:
            stored = self._read_all().get(provider)
        if stored:
            return stored
        if not env_fallback_enabled(self._env):
            return None
        for name in ENV_VARS.get(provider, ()):
            value = self._env.get(name)
            if value:
                return value
        return None

    def set(self, provider: str, value: str) -> None:
        with _VAULT_LOCK:
            values = self._read_all()
            values[provider] = value
            self._write_all(values)

    def delete(self, provider: str) -> None:
        with _VAULT_LOCK:
            values = self._read_all()
            if values.pop(provider, None) is None:
                return
            self._write_all(values)
