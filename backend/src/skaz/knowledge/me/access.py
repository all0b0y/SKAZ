"""One «Я» store per knowledge service (its vault lives in ``<data>/secrets`` beside the provider keys)."""
from __future__ import annotations

import threading
import weakref

from ..service import KnowledgeService
from .graph import GRAPH_ACTIVE, GraphUnavailable, MeGraphStore
from .store import MeStore
from .vault import MeVault

SECRETS_DIR = "secrets"

_STORES: weakref.WeakKeyDictionary[KnowledgeService, MeStore] = weakref.WeakKeyDictionary()
_GRAPHS: weakref.WeakKeyDictionary[KnowledgeService, MeGraphStore] = weakref.WeakKeyDictionary()
_LOCK = threading.Lock()


def me_store(kb: KnowledgeService) -> MeStore:
    with _LOCK:
        if legacy_retired(kb):
            raise GraphUnavailable()
        store = _STORES.get(kb)
        if store is None:
            store = _STORES[kb] = MeStore(MeVault(kb.data_dir / SECRETS_DIR))
        return store


def bind_graph(kb: KnowledgeService, store: MeGraphStore) -> None:
    with _LOCK:
        _GRAPHS[kb] = store


def graph_store(kb: KnowledgeService) -> MeGraphStore | None:
    with _LOCK:
        return _GRAPHS.get(kb)


def legacy_retired(kb: KnowledgeService) -> bool:
    return (kb.data_dir / SECRETS_DIR / GRAPH_ACTIVE).exists()
