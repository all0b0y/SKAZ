"""Known vulnerable runtime versions must not re-enter a locked release environment."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

import pytest
from packaging.version import Version


@pytest.mark.parametrize(
    ("distribution", "minimum", "optional"),
    [
        ("pypdf", "6.21.2", False),
        ("filelock", "4.2.1", True),
        ("opentelemetry-api", "1.45.1", True),
    ],
)
def test_runtime_dependencies_meet_security_floors(
    distribution: str, minimum: str, optional: bool,
) -> None:
    """Optional packages need the fixed floor whenever they are installed and can ship."""
    try:
        installed = version(distribution)
    except PackageNotFoundError:
        if optional:
            pytest.skip(f"{distribution} is not installed in this runtime")
        raise
    assert Version(installed) >= Version(minimum), (
        f"{distribution} {installed} is below the security floor {minimum}"
    )
