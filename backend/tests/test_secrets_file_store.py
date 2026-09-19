"""Behaviour contract for the encrypted on-disk secret store.

The macOS Keychain binds an item's ACL to the binary that created it. SKAZ ships
without a Developer ID certificate, so the shipped bundle could not own stable
Keychain items and provider keys silently failed to persist (`KeyringLocked`).
The file vault removes that dependency: keys live in the app's own data
directory, encrypted at rest, and survive a restart regardless of signing.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from audiohelper.secrets import FileSecretStore


@pytest.fixture
def vault_dir(tmp_path: Path) -> Path:
    return tmp_path / "secrets"


def test_value_survives_a_new_store_instance(vault_dir: Path) -> None:
    """The point of the whole exercise: a restart must not lose the key."""
    FileSecretStore(vault_dir).set("soniox", "sk-live-value")

    assert FileSecretStore(vault_dir).get("soniox") == "sk-live-value"


def test_unknown_provider_reads_as_absent(vault_dir: Path) -> None:
    assert FileSecretStore(vault_dir).get("openai") is None


def test_providers_are_stored_independently(vault_dir: Path) -> None:
    store = FileSecretStore(vault_dir)
    store.set("soniox", "sk-soniox")
    store.set("openai", "sk-openai")

    store.delete("soniox")

    assert store.get("soniox") is None
    assert store.get("openai") == "sk-openai"


def test_deleting_an_absent_provider_is_not_an_error(vault_dir: Path) -> None:
    FileSecretStore(vault_dir).delete("anthropic")


def test_overwriting_replaces_the_previous_value(vault_dir: Path) -> None:
    store = FileSecretStore(vault_dir)
    store.set("soniox", "sk-old")
    store.set("soniox", "sk-new")

    assert store.get("soniox") == "sk-new"


def test_secret_is_not_recoverable_from_the_vault_file(vault_dir: Path) -> None:
    """Encrypted at rest: a backup or stray file copy must not leak the key."""
    FileSecretStore(vault_dir).set("soniox", "sk-plaintext-canary")

    blob = (vault_dir / "secrets.json.enc").read_bytes()

    assert b"sk-plaintext-canary" not in blob
    assert b"soniox" not in blob


def test_key_and_vault_are_not_readable_by_other_users(vault_dir: Path) -> None:
    """The key sits next to the ciphertext, so file permissions are the boundary."""
    FileSecretStore(vault_dir).set("soniox", "sk-value")

    for name in ("secrets.key", "secrets.json.enc"):
        mode = stat.S_IMODE(os.stat(vault_dir / name).st_mode)
        assert mode & (stat.S_IRWXG | stat.S_IRWXO) == 0, f"{name} is group/world accessible"

    dir_mode = stat.S_IMODE(os.stat(vault_dir).st_mode)
    assert dir_mode & (stat.S_IRWXG | stat.S_IRWXO) == 0


def test_a_corrupt_vault_does_not_crash_the_backend(vault_dir: Path) -> None:
    """A truncated or foreign file must read as "no keys", not take the app down."""
    store = FileSecretStore(vault_dir)
    store.set("soniox", "sk-value")
    (vault_dir / "secrets.json.enc").write_bytes(b"not a fernet token")

    assert store.get("soniox") is None
    store.set("soniox", "sk-recovered")
    assert FileSecretStore(vault_dir).get("soniox") == "sk-recovered"


def test_environment_fallback_stays_opt_in(vault_dir: Path) -> None:
    env = {"SONIOX_API_KEY": "sk-from-env"}
    assert FileSecretStore(vault_dir, env=env).get("soniox") is None

    opted_in = {**env, "AUDIOHELPER_ALLOW_ENV_KEYS": "1"}
    assert FileSecretStore(vault_dir, env=opted_in).get("soniox") == "sk-from-env"


def test_a_stored_value_wins_over_the_environment(vault_dir: Path) -> None:
    env = {"SONIOX_API_KEY": "sk-from-env", "AUDIOHELPER_ALLOW_ENV_KEYS": "1"}
    store = FileSecretStore(vault_dir, env=env)
    store.set("soniox", "sk-stored")

    assert store.get("soniox") == "sk-stored"
