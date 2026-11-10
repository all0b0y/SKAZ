"""Science contracts for SKAZ 0.4.0 and B1's client (``runtime.kb_science``).

Importing this package loads nothing else: ``api/science.py`` imports ``science.protocols``, and the
client imports the API schemas, so ``build_science`` is imported lazily by ``runtime.py`` only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .client import ScienceGateway


def build_science(runtime: Any) -> ScienceGateway:
    """The science client on the runtime's own secret store and HTTP client."""
    from .client import ScienceGateway

    return ScienceGateway(runtime.kb, runtime.secrets, runtime.http)
