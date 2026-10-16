"""Key-check fingerprints: salted per installation, slow to brute-force, never the key."""
from __future__ import annotations

import hashlib
from typing import Any

import httpx

from skaz.knowledge.settings import keys as keys_module
from skaz.knowledge.settings.keys import KeyChecks, fingerprint

KEY = "sk-test-0123456789abcdef"


class Settings:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}

    def get(self, key: str) -> Any:
        return self.values.get(key)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value


def checks(settings: Settings, key: str | None = KEY) -> KeyChecks:
    return KeyChecks(settings, lambda _provider: key, httpx.AsyncClient())  # type: ignore[arg-type]


def test_fingerprint_is_salted_and_not_a_plain_hash() -> None:
    first, second = fingerprint(KEY, b"a" * 32), fingerprint(KEY, b"b" * 32)
    assert first != second
    assert first not in hashlib.sha256(KEY.encode()).hexdigest()
    assert KEY not in first and len(first) == 32


async def test_a_checked_key_is_recognised_and_a_changed_one_is_not() -> None:
    settings = Settings()
    service = checks(settings)
    settings.values[keys_module._STORE_KEY + "openrouter"] = {
        "fingerprint": service._fingerprint(KEY), "checked_at": "2026-10-15T00:00:00+00:00", "valid": True}
    assert service.status("openrouter").valid is True
    salt = settings.values[keys_module._SALT_KEY]
    assert isinstance(salt, str) and len(salt) == 64
    # The salt persists: a new process recognises the same key.
    assert checks(settings).status("openrouter").valid is True
    assert checks(settings, "sk-other-key-000000000000").status("openrouter").valid is None
    assert KEY not in repr(settings.values)


async def test_two_installations_store_different_fingerprints_for_one_key() -> None:
    one, two = Settings(), Settings()
    assert checks(one)._fingerprint(KEY) != checks(two)._fingerprint(KEY)
