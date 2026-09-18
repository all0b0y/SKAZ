"""Provider API keys.

Keys live in the OS keychain (or the process environment for CI/headless use).
They are never written to the database, the API responses or the logs.

Each provider gets its own keychain service name (``AudioHelper:<provider>``) so a
single granted keychain item never exposes every provider's credential at once.

Known limitation: the keychain ACL is bound to the binary that created the item —
today the Python interpreter, not a signed AudioHelper bundle. Another process run
by the same user with the same interpreter can therefore read these keys without a
prompt. Binding the items to a signed bundle is tracked in docs/STATUS.md.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Protocol

logger = logging.getLogger(__name__)

SERVICE_NAME = "AudioHelper"

#: Environment variables accepted as a source for a provider key. Read only in an
#: explicit development/CI run (see ``env_fallback_enabled``); a normal desktop run
#: never picks a credential up from the ambient environment.
ENV_VARS: Mapping[str, tuple[str, ...]] = {
    "openrouter": ("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
}

#: Opt-in switch for the environment fallback above.
ENV_FALLBACK_FLAG = "AUDIOHELPER_ALLOW_ENV_KEYS"


def service_name(provider: str) -> str:
    """Per-provider keychain service, so one granted item unlocks one provider."""
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


class KeyringSecretStore:
    """OS keychain storage with a read-only environment fallback."""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self._env = os.environ if env is None else env

    def get(self, provider: str) -> str | None:
        import keyring

        try:
            stored = keyring.get_password(service_name(provider), provider)
        except Exception as error:  # locked or unavailable keychain must not break the backend
            logger.warning("Keychain unavailable for one provider: %s", type(error).__name__)
            stored = None
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
        import keyring

        keyring.set_password(service_name(provider), provider, value)

    def delete(self, provider: str) -> None:
        import contextlib

        import keyring

        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            keyring.delete_password(service_name(provider), provider)
