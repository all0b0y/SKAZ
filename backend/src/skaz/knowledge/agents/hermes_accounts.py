"""The Hermes providers of Settings → Accounts & keys (K1, K3): read, add, sign in again, remove, move.

See :mod:`.hermes_providers` for what each Hermes command is and why SKAZ never sees a secret.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from ..errors import KnowledgeError, NotFound
from .hermes import NOT_INSTALLED, HermesEngine
from .hermes_launchers import LauncherTampered
from .hermes_providers import (
    CATALOG,
    SAFE_CREDENTIAL,
    SAFE_ID,
    CatalogProvider,
    Credential,
    ProviderGroup,
    ProviderPool,
    TerminalCommand,
    add_command,
    add_key_command,
    catalog_entry,
    order_command,
    ordered,
    other_command,
    parse_auth_list,
    provider_order,
    sign_in_again_command,
)

log = logging.getLogger(__name__)

AccountsState = Literal["ready", "not_installed", "unavailable"]
TerminalState = Literal["running", "done", "failed"]
LIST_FAILED = "Hermes didn't list its providers. Check Hermes Agent above, then try again."
COMMAND_FAILED = "Hermes didn't do it: {detail}"
TERMINAL_FAILED = "SKAZ couldn't open Terminal for Hermes."
UNKNOWN_PROVIDER = "SKAZ doesn't know this provider. Use “Other provider…” to add it in Hermes."
NO_CREDENTIAL = "This credential is no longer in Hermes. The list was read again."
NO_PROVIDER = "This provider is no longer in Hermes. The list was read again."
NO_KEYS = "Hermes adds keys only to providers that use API keys. Use “Other provider…” for anything else."
KEY_NAME = "Give the key a name of up to {limit} characters, on one line."
KEY_NAME_TAKEN = "{provider} already has a key named “{label}”. Choose another name."
#: Longest key name SKAZ passes to ``hermes auth add --label`` (Hermes itself has no limit).
KEY_NAME_MAX = 40


class AccountsError(KnowledgeError):
    status_code = 409


class KeyNameError(AccountsError):
    status_code = 422


def key_name(label: str) -> str:
    """A key's name as Hermes stores it (``--label``): one printable line, trimmed, ≤ KEY_NAME_MAX."""
    name = label.strip()
    if not name or len(name) > KEY_NAME_MAX or any(not char.isprintable() for char in name):
        raise KeyNameError(KEY_NAME.format(limit=KEY_NAME_MAX))
    return name


@dataclass(frozen=True)
class OpenedTerminal:
    name: str
    title: str
    provider: str | None
    started_at: str


@dataclass(frozen=True)
class TerminalView:
    provider: str | None
    title: str
    state: TerminalState
    started_at: str


@dataclass(frozen=True)
class AccountsView:
    state: AccountsState
    reason: str | None
    providers: tuple[ProviderPool, ...]
    catalog: tuple[CatalogProvider, ...]
    terminal: TerminalView | None
    read_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _short(text: str) -> str:
    """Hermes' own message for a refusal (its stderr/stdout tail; Hermes prints no secret there)."""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    return (lines[-1] if lines else "no reason given")[:300]


@dataclass
class HermesAccounts:
    engine: HermesEngine
    #: The last Terminal window SKAZ opened for providers (the card says "Finish in Terminal").
    opened: OpenedTerminal | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def terminal(self) -> TerminalView | None:
        opened = self.opened
        if opened is None:
            return None
        code = self.engine.terminal_finished(opened.name)
        state: TerminalState = "running" if code is None else "done" if code == 0 else "failed"
        return TerminalView(opened.provider, opened.title, state, opened.started_at)

    async def _get(self, key: str) -> str | None:
        """``hermes config get <key> --json``; ``None`` when unset or not answered."""
        try:
            out = await self.engine.cli("config", "get", key, "--json")
        except (OSError, TimeoutError):
            return None
        return out.stdout if out.returncode == 0 else None

    async def view(self) -> AccountsView:
        """What Hermes keeps in SKAZ's folder, in the order Hermes tries it."""
        async with self._lock:
            try:
                listing, main, fallbacks, legacy = await asyncio.gather(
                    self.engine.cli("auth", "list"), self._get("model.provider"),
                    self._get("fallback_providers"), self._get("fallback_model"))
            except FileNotFoundError:
                return AccountsView("not_installed", NOT_INSTALLED, (), CATALOG, self.terminal(), _now())
            except LauncherTampered as error:
                return AccountsView("unavailable", str(error), (), CATALOG, self.terminal(), _now())
            except (OSError, TimeoutError):
                return AccountsView("unavailable", LIST_FAILED, (), CATALOG, self.terminal(), _now())
            if listing.returncode != 0:
                log.warning("hermes auth list ended with exit code %s", listing.returncode)
                return AccountsView("unavailable", LIST_FAILED, (), CATALOG, self.terminal(), _now())
            pools = ordered(parse_auth_list(listing.stdout), provider_order(main, fallbacks, legacy))
            return AccountsView("ready", None, tuple(pools), CATALOG, self.terminal(), _now())

    async def _open(self, command: TerminalCommand) -> AccountsView:
        try:
            await self.engine.open_terminal(command.name, command.title, command.commands,
                                            close_on_success=command.close_on_success,
                                            done_note=command.done_note)
        except FileNotFoundError as error:
            raise AccountsError(NOT_INSTALLED) from error
        except LauncherTampered as error:
            raise AccountsError(str(error)) from error
        except OSError as error:
            raise AccountsError(TERMINAL_FAILED) from error
        self.opened = OpenedTerminal(command.name, command.title, command.provider, _now())
        log.info("Opened Terminal for Hermes providers (%s)", command.name)
        return await self.view()

    async def add(self, provider: str, group: ProviderGroup) -> AccountsView:
        entry = catalog_entry(provider, group)
        if entry is None:
            raise NotFound(UNKNOWN_PROVIDER)
        return await self._open(add_command(entry))

    async def add_key(self, provider: str, label: str) -> AccountsView:
        """Another named API key for a provider: Hermes asks for the key in Terminal; SKAZ passes
        only the name (``hermes auth add <provider> --type api-key --label <name>``)."""
        name = key_name(label)
        if not SAFE_ID.fullmatch(provider):
            raise NotFound(NO_KEYS)
        entry = catalog_entry(provider, "api_key")
        current = await self.view()
        pool = next((item for item in current.providers if item.id == provider), None)
        has_keys = pool is not None and any(c.auth_type == "api_key" for c in pool.credentials)
        if entry is None and not has_keys:
            raise NotFound(NO_KEYS)
        if pool is not None and any(c.label == name for c in pool.credentials):
            raise AccountsError(KEY_NAME_TAKEN.format(provider=pool.name, label=name))
        shown = pool.name if pool is not None else entry.name if entry is not None else provider
        return await self._open(add_key_command(provider, shown, name))

    async def add_other(self) -> AccountsView:
        return await self._open(other_command())

    async def open_order(self) -> AccountsView:
        return await self._open(order_command())

    async def _credential(self, provider: str, credential_id: str) -> tuple[ProviderPool, Credential]:
        if not SAFE_ID.fullmatch(provider) or not SAFE_CREDENTIAL.fullmatch(credential_id):
            raise NotFound(NO_CREDENTIAL)
        current = await self.view()
        pool = next((item for item in current.providers if item.id == provider), None)
        credential = (next((item for item in pool.credentials if item.id == credential_id), None)
                      if pool else None)
        if pool is None or credential is None:
            raise NotFound(NO_CREDENTIAL)
        return pool, credential

    async def sign_in_again(self, provider: str, credential_id: str) -> AccountsView:
        pool, credential = await self._credential(provider, credential_id)
        return await self._open(sign_in_again_command(pool, credential))

    async def _run(self, *args: str) -> None:
        try:
            out = await self.engine.cli(*args)
        except FileNotFoundError as error:
            raise AccountsError(NOT_INSTALLED) from error
        except LauncherTampered as error:
            raise AccountsError(str(error)) from error
        except (OSError, TimeoutError) as error:
            raise AccountsError(LIST_FAILED) from error
        if out.returncode != 0:
            raise AccountsError(COMMAND_FAILED.format(detail=_short(out.stderr or out.stdout)))

    async def remove(self, provider: str, credential_id: str) -> AccountsView:
        await self._credential(provider, credential_id)
        await self._run("auth", "remove", provider, credential_id)
        log.info("Removed a %s credential from SKAZ's Hermes folder", provider)
        return await self.view()

    async def remove_provider(self, provider: str) -> AccountsView:
        """Every credential the user added for a provider, each with ``hermes auth remove`` (no secret)."""
        if not SAFE_ID.fullmatch(provider):
            raise NotFound(NO_PROVIDER)
        current = await self.view()
        pool = next((item for item in current.providers if item.id == provider), None)
        if pool is None or not pool.credentials:
            raise NotFound(NO_PROVIDER)
        for credential in pool.credentials:
            await self._run("auth", "remove", provider, credential.id)
        log.info("Removed %d %s credentials from SKAZ's Hermes folder", len(pool.credentials), provider)
        return await self.view()

    async def move(self, provider: str, credential_id: str, priority: int) -> AccountsView:
        pool, _credential = await self._credential(provider, credential_id)
        target = max(0, min(priority, len(pool.credentials) - 1))
        await self._run("auth", "priority", provider, credential_id, str(target))
        return await self.view()
