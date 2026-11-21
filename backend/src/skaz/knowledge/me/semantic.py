"""Offline sentence features. Only immutable model weights are shared between profiles."""

from __future__ import annotations

import logging
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from onnxruntime import InferenceSession
    from tokenizers import Tokenizer

log = logging.getLogger(__name__)


class LocalEncoder:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or Path(__file__).with_name("encoder")
        self._lock = Lock()
        self._ready = False
        self._runtime: tuple[Tokenizer, InferenceSession] | None = None

    def _load(self) -> tuple[Tokenizer, InferenceSession] | None:
        with self._lock:
            if not self._ready:
                try:
                    from onnxruntime import InferenceSession, SessionOptions
                    from tokenizers import Tokenizer

                    tokenizer = Tokenizer.from_file(str(self.directory / "tokenizer.json"))
                    tokenizer.enable_truncation(max_length=96)
                    options = SessionOptions()
                    options.intra_op_num_threads = options.inter_op_num_threads = 1
                    runtime = InferenceSession(
                        str(self.directory / "encoder.onnx"), options, providers=["CPUExecutionProvider"]
                    )
                    self._runtime = tokenizer, runtime
                except Exception as error:
                    log.warning("Me local encoder unavailable (%s); using word search.", type(error).__name__)
                self._ready = True
            return self._runtime

    def vector(self, text: str) -> tuple[float, ...]:
        runtime = self._load()
        if runtime is None or not text.strip():
            return ()
        import numpy as np

        tokenizer, session = runtime
        try:
            encoded = tokenizer.encode(text[:2048])
            values = (encoded.ids, encoded.attention_mask, encoded.type_ids)
            inputs = {
                key: np.asarray([ids], dtype=np.int64)
                for key, ids in zip(("input_ids", "attention_mask", "token_type_ids"), values, strict=True)
            }
            output = np.asarray(session.run(None, inputs)[0])[0, 0]
            norm = float(np.linalg.norm(output))
            return tuple(float(value) for value in output / norm) if norm > 0 else ()
        except Exception as error:
            log.warning("Me local encoding failed (%s); using word search.", type(error).__name__)
            return ()


ENCODER = LocalEncoder()
