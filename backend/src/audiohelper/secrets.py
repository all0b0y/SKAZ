"""Provider API keys.

Keys live in the OS keychain (or the process environment for CI/headless use).
They are never written to the database, the API responses or the logs.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Protocol

logger = logging.getLogger(__name__)

SERVICE_NAME = "AudioHelper"

#: Environment variables accepted as a source for a provider key.
ENV_VARS: Mapping[str, tuple[str, ...]] = {
    "openrouter": ("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openai-compatible": ("AUDIOHELPER_COMPATIBLE_API_KEY",),
}


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


class KeyringSecretStore:
    """OS keychain storage with a read-only environment fallback."""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self._env = os.environ if env is None else env

    def get(self, provider: str) -> str | None:
        import keyring

        try:
            stored = keyring.get_password(SERVICE_NAME, provider)
        except Exception as error:  # locked or unavailable keychain must not break the backend
            logger.warning("Keychain unavailable, falling back to environment: %s", error)
            stored = None
        if stored:
            return stored
        for name in ENV_VARS.get(provider, ()):
            value = self._env.get(name)
            if value:
                return value
        return None

    def set(self, provider: str, value: str) -> None:
        import keyring

        keyring.set_password(SERVICE_NAME, provider, value)

    def delete(self, provider: str) -> None:
        import contextlib

        import keyring

        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            keyring.delete_password(SERVICE_NAME, provider)
