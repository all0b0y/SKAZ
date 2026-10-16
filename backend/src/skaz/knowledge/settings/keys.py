"""API keys of the new settings: presence, a cheap validity check, never the key itself.

Keys live in the app's existing secret store (``runtime.secrets``) and are
written through the legacy settings update (which also stops cloud streams
whose key was removed). A check is one cheap authenticated request that sends
no user data; its result is remembered with a fingerprint of the key, so a
changed key is never shown as checked.
"""
from __future__ import annotations

import hashlib
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, get_args

import httpx

from ..errors import KnowledgeError
from ..store.repositories import SettingsRepository

KeyProvider = Literal["openrouter", "soniox", "openai"]
KEY_PROVIDERS: tuple[KeyProvider, ...] = get_args(KeyProvider)
LABELS: dict[KeyProvider, str] = {"openrouter": "OpenRouter", "soniox": "Soniox", "openai": "OpenAI"}
#: One authenticated request per provider that reads nothing of the user's and costs nothing.
CHECK_URLS: dict[KeyProvider, str] = {
    "openrouter": "https://openrouter.ai/api/v1/key",
    "soniox": "https://api.soniox.com/v1/files?limit=1",
    "openai": "https://api.openai.com/v1/models",
}
CHECK_TIMEOUT_S = 15.0
_STORE_KEY = "settings.keys.check."
_SALT_KEY = "settings.keys.fingerprint_salt"
#: PBKDF2 rounds for a fingerprint: computed once per key and process (memoised).
FINGERPRINT_ROUNDS = 100_000


class KeyCheckFailed(KnowledgeError):
    """The provider couldn't be asked (network, outage): nothing is known about the key."""

    status_code = 502


class NoKey(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class KeyStatus:
    id: KeyProvider
    configured: bool
    checked_at: str | None
    valid: bool | None


def fingerprint(key: str, salt: bytes) -> str:
    """Identifies *which* key was checked: PBKDF2-HMAC-SHA256 with this installation's secret salt.

    Not reversible, salted per installation (the same key gives different fingerprints
    on two Macs) and slow to brute-force; too short to stand in for the key.
    """
    return hashlib.pbkdf2_hmac("sha256", key.encode("utf-8"), salt, FINGERPRINT_ROUNDS).hex()[:32]


class KeyChecks:
    def __init__(self, settings: SettingsRepository, api_key: Callable[[str], str | None],
                 http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._api_key = api_key
        self._http = http
        self._fingerprints: dict[str, str] = {}

    def _salt(self) -> bytes:
        stored = self._settings.get(_SALT_KEY)
        if isinstance(stored, str) and len(stored) == 64:
            return bytes.fromhex(stored)
        salt = secrets.token_bytes(32)
        self._settings.set(_SALT_KEY, salt.hex())
        return salt

    def _fingerprint(self, key: str) -> str:
        if key not in self._fingerprints:
            self._fingerprints[key] = fingerprint(key, self._salt())
        return self._fingerprints[key]

    def status(self, provider: KeyProvider) -> KeyStatus:
        key = self._api_key(provider)
        if not key:
            return KeyStatus(provider, False, None, None)
        record: Any = self._settings.get(_STORE_KEY + provider)
        if isinstance(record, dict) and record.get("fingerprint") == self._fingerprint(key):
            return KeyStatus(provider, True, record.get("checked_at"), bool(record.get("valid")))
        return KeyStatus(provider, True, None, None)

    def statuses(self) -> list[KeyStatus]:
        return [self.status(provider) for provider in KEY_PROVIDERS]

    def forget(self, provider: KeyProvider) -> None:
        self._settings.set(_STORE_KEY + provider, None)

    async def check(self, provider: KeyProvider) -> KeyStatus:
        key = self._api_key(provider)
        if not key:
            raise NoKey(f"No {LABELS[provider]} key is stored.")
        try:
            response = await self._http.get(CHECK_URLS[provider], headers={"Authorization": f"Bearer {key}"},
                                            timeout=CHECK_TIMEOUT_S)
        except httpx.HTTPError as error:
            raise KeyCheckFailed(f"SKAZ couldn't reach {LABELS[provider]}. Check the internet connection."
                                 ) from error
        if response.status_code in (401, 403):
            valid = False
        elif response.is_success:
            valid = True
        else:
            raise KeyCheckFailed(f"{LABELS[provider]} didn't answer the check now. Try again later.")
        checked_at = datetime.now(UTC).isoformat(timespec="seconds")
        self._settings.set(_STORE_KEY + provider,
                           {"fingerprint": self._fingerprint(key), "checked_at": checked_at, "valid": valid})
        return KeyStatus(provider, True, checked_at, valid)
