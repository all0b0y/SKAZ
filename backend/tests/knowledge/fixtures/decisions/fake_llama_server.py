"""A stand-in for ``llama-server`` used by the D1 tests: a real local HTTP process, no model.

Speaks the subset SKAZ uses: ``GET /health``, ``POST /apply-template``,
``POST /completion`` (``n_probs``) and ``POST /v1/systemone``; requires the
per-launch key from ``LLAMA_ARG_API_KEY``. ``FAKE_LLAMA_TOP`` (JSON list of
``[token, probability]``) sets the next-token candidates; ``FAKE_LLAMA_EXIT``
makes it exit at once (a server that cannot start). Not evidence of model quality.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOP = json.loads(os.environ.get("FAKE_LLAMA_TOP", '[["A", 0.9], ["B", 0.05], ["The", 0.05]]'))
KEY = os.environ.get("LLAMA_ARG_API_KEY", "")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _send(self, status: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            self._send(401, {"error": "invalid api key"})
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if self.path == "/apply-template":
            text = "".join(f"<{m['role']}>{m['content']}</{m['role']}>" for m in body["messages"])
            self._send(200, {"prompt": text + "<assistant>"})
        elif self.path == "/completion":
            top = [{"id": i, "token": token, "logprob": math.log(p), "bytes": []}
                   for i, (token, p) in enumerate(TOP[: body.get("n_probs", 0)])]
            self._send(200, {"content": TOP[0][0], "completion_probabilities": [
                {"id": 0, "token": TOP[0][0], "logprob": math.log(TOP[0][1]), "bytes": [],
                 "top_logprobs": top},
            ]})
        elif self.path == "/v1/systemone":
            answers = {}
            for qid, question in body["questions"].items():
                if question["type"] == "noul":
                    answers[qid] = {"type": "noul", "noul": 0.97}
                elif question["type"] == "choice":
                    keys = list(question["criteria"])
                    probabilities = {key: (0.94 if i == 0 else 0.06 / (len(keys) - 1))
                                     for i, key in enumerate(keys)}
                    answers[qid] = {"type": "choice", "choice": keys[0], "probabilities": probabilities,
                                    "confidence": 0.9}
                else:
                    levels = len(question["criteria"])
                    answers[qid] = {"type": "score", "score": 0.0, "confidence": 1.0,
                                    "probabilities": {str(i): (1.0 if i == 0 else 0.0)
                                                      for i in range(levels)}}
            usage = {"input_tokens": 1, "output_tokens": 0}
            self._send(200, {"model": "fake", "answers": answers, "usage": usage})
        else:
            self._send(404, {"error": "not found"})


def main() -> None:
    if os.environ.get("FAKE_LLAMA_EXIT"):
        sys.exit(3)
    parser = argparse.ArgumentParser()
    parser.add_argument("-m")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--no-webui", action="store_true")
    parser.add_argument("-np")
    parser.add_argument("-c")
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
