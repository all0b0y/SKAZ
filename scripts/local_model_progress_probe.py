"""Probe AudioHelper's Hugging Face progress callback with one tiny public README.

This is optional evidence, not a model download.  It resolves public metadata
without a token, refuses files over 100 KB before download, uses a fresh
temporary cache, and allowlists exactly README.md.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import httpx
from huggingface_hub import HfApi, snapshot_download

from audiohelper.local_models import DownloadProgress, _progress_tqdm

REPOSITORY = "Systran/faster-whisper-small"
FILENAME = "README.md"
MAX_DOWNLOAD_BYTES = 100_000


def main() -> int:
    api = HfApi(token=False)
    try:
        info = api.model_info(REPOSITORY, files_metadata=True)
    except httpx.HTTPError as error:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "phase": "public_metadata",
                    "error_type": type(error).__name__,
                    "temporary_cache_created": False,
                    "model_weights_downloaded": False,
                },
                sort_keys=True,
            )
        )
        return 2
    readme = next((item for item in info.siblings if item.rfilename == FILENAME), None)
    if readme is None or readme.size is None:
        raise RuntimeError("Public README metadata did not include a declared size; refusing download.")
    if readme.size > MAX_DOWNLOAD_BYTES:
        raise RuntimeError(
            f"Public README is {readme.size} bytes, above the {MAX_DOWNLOAD_BYTES}-byte safety limit."
        )
    if info.sha is None:
        raise RuntimeError("Public repository metadata did not include an immutable revision.")

    reports: list[DownloadProgress] = []
    with tempfile.TemporaryDirectory(prefix="audiohelper-progress-probe-") as cache:
        snapshot = Path(
            snapshot_download(
                repo_id=REPOSITORY,
                revision=info.sha,
                cache_dir=cache,
                allow_patterns=[FILENAME],
                max_workers=1,
                token=False,
                tqdm_class=_progress_tqdm(reports.append),
            )
        )
        downloaded = snapshot / FILENAME
        actual_bytes = downloaded.stat().st_size
        snapshot_files = sorted(
            str(path.relative_to(snapshot)) for path in snapshot.rglob("*") if path.is_file()
        )

    reported_bytes = reports[-1].downloaded_bytes if reports else 0
    reported_total = reports[-1].total_bytes if reports else None
    assertions = {
        "measured_bytes_match_file": bool(reports) and reported_bytes == actual_bytes,
        "snapshot_contains_only_readme": snapshot_files == [FILENAME],
        "transfer_total_remains_unknown": bool(reports) and reported_total is None,
    }
    passed = all(assertions.values())

    print(
        json.dumps(
            {
                "status": "passed" if passed else "failed",
                "repository": REPOSITORY,
                "revision": info.sha,
                "filename": FILENAME,
                "declared_bytes": readme.size,
                "actual_bytes": actual_bytes,
                "max_download_bytes": MAX_DOWNLOAD_BYTES,
                "reported_downloaded_bytes": reported_bytes,
                "reported_total_bytes": reported_total,
                "snapshot_files": snapshot_files,
                "assertions": assertions,
                "temporary_cache_removed": True,
                "model_weights_downloaded": False,
            },
            sort_keys=True,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
