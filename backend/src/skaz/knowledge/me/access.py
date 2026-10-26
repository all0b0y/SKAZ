"""One «Я» store per knowledge service (its vault lives in ``<data>/secrets`` beside the provider keys)."""
from __future__ import annotations

import threading
import weakref

from ..service import KnowledgeService
from .store import MeStore
from .vault import MeVault

SECRETS_DIR = "secrets"

_STORES: weakref.WeakKeyDictionary[KnowledgeService, MeStore] = weakref.WeakKeyDictionary()
_LOCK = threading.Lock()


def me_store(kb: KnowledgeService) -> MeStore:
    with _LOCK:
        store = _STORES.get(kb)
        if store is None:
            store = _STORES[kb] = MeStore(MeVault(kb.data_dir / SECRETS_DIR))
        return store
