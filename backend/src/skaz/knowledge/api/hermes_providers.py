"""``/kb/agents/hermes/providers``: Hermes' providers in SKAZ's folder (0.3.1 K1/K3).

Adding a provider and signing in again open Hermes' own command in Terminal; the key or sign-in
goes to Hermes, never through SKAZ (no request here carries a secret).
"""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Path, Request

from ..agents.hermes_accounts import AccountsView, HermesAccounts
from ..agents.hermes_providers import CATALOG_CHECKED
from ..agents.hub import AgentsHub
from ..errors import KnowledgeError
from .schemas_agents import (
    KbHermesCatalogItem,
    KbHermesCredential,
    KbHermesCredentialMove,
    KbHermesKeyAdd,
    KbHermesProvider,
    KbHermesProviderAdd,
    KbHermesProviders,
    KbHermesTerminal,
)

router = APIRouter(prefix="/kb/agents/hermes/providers", tags=["kb"])
ProviderId = Annotated[str, Path(min_length=1, max_length=64)]
CredentialId = Annotated[str, Path(min_length=1, max_length=64)]


def get_accounts(request: Request) -> HermesAccounts:
    hub = cast(AgentsHub, request.app.state.runtime.kb_agents)
    if hub.hermes_accounts is None:
        raise HTTPException(status_code=409, detail="Hermes Agent is not available in this SKAZ.")
    return hub.hermes_accounts


AccountsDep = Annotated[HermesAccounts, Depends(get_accounts)]


def view(value: AccountsView) -> KbHermesProviders:
    terminal = value.terminal
    return KbHermesProviders(
        state=value.state, reason=value.reason,
        providers=[KbHermesProvider(
            id=pool.id, name=pool.name, free_tier=pool.free_tier, order=pool.order,
            credentials=[KbHermesCredential(
                index=c.index, id=c.id, label=c.label, auth_type=c.auth_type, priority=c.priority,
                state=c.state, until=c.until, detail=c.detail, current=c.current) for c in pool.credentials],
        ) for pool in value.providers],
        catalog=[KbHermesCatalogItem(id=item.id, name=item.name, group=item.group, keywords=item.keywords)
                 for item in value.catalog],
        catalog_checked=CATALOG_CHECKED,
        terminal=(KbHermesTerminal(provider=terminal.provider, title=terminal.title, state=terminal.state,
                                   started_at=terminal.started_at) if terminal is not None else None),
        read_at=value.read_at,
    )


def _http(error: KnowledgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


@router.get("")
async def list_providers(accounts: AccountsDep) -> KbHermesProviders:
    return view(await accounts.view())


@router.post("/add")
async def add_provider(body: KbHermesProviderAdd, accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.add(body.provider, body.group))
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/other")
async def add_other_provider(accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.add_other())
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/order")
async def open_provider_order(accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.open_order())
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/{provider}/credentials/{credential_id}/sign-in")
async def sign_in_again(provider: ProviderId, credential_id: CredentialId,
                        accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.sign_in_again(provider, credential_id))
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/{provider}/credentials/{credential_id}/priority")
async def move_credential(provider: ProviderId, credential_id: CredentialId, body: KbHermesCredentialMove,
                          accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.move(provider, credential_id, body.priority))
    except KnowledgeError as error:
        raise _http(error) from error


@router.delete("/{provider}/credentials/{credential_id}")
async def remove_credential(provider: ProviderId, credential_id: CredentialId,
                            accounts: AccountsDep) -> KbHermesProviders:
    try:
        return view(await accounts.remove(provider, credential_id))
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/{provider}/keys")
async def add_key(provider: ProviderId, body: KbHermesKeyAdd, accounts: AccountsDep) -> KbHermesProviders:
    """Another named API key: Terminal opens Hermes, which asks for the key (SKAZ sends only the name)."""
    try:
        return view(await accounts.add_key(provider, body.label))
    except KnowledgeError as error:
        raise _http(error) from error


@router.delete("/{provider}")
async def remove_provider(provider: ProviderId, accounts: AccountsDep) -> KbHermesProviders:
    """Every credential of the provider removed from Hermes (each with ``hermes auth remove``)."""
    try:
        return view(await accounts.remove_provider(provider))
    except KnowledgeError as error:
        raise _http(error) from error
