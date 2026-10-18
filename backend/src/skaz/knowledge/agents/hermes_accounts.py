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


class AccountsError(KnowledgeError):
    status_code = 409


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
            await self.engine.open_terminal(command.name, command.title, command.commands)
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

    async def move(self, provider: str, credential_id: str, priority: int) -> AccountsView:
        pool, _credential = await self._credential(provider, credential_id)
        target = max(0, min(priority, len(pool.credentials) - 1))
        await self._run("auth", "priority", provider, credential_id, str(target))
        return await self.view()
