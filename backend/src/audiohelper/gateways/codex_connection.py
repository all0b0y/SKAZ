"""Official Codex account lifecycle in SKAZ's own profile, never another app's tokens."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .codex_locate import CodexLocation, locate_codex
from .codex_rpc import CodexRpc
from .codex_session import DISABLED_FEATURES

# How long the official browser login may stay open before it is abandoned.
LOGIN_TIMEOUT_S: float = 300

# `login` in the view: idle, pending (browser page open), or how the last
# attempt ended without an account — failed, cancelled or timed_out. The UI
# watches it instead of asking the user to re-check after signing in.
LOGIN_FAILURES = {
    "failed": "Login did not complete",
    "cancelled": "Login cancelled",
    "timed_out": "Login timed out",
}


class CodexConnection:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.cwd = root / "work"
        self.binary: str | None = None
        self.location: CodexLocation | None = None
        self.view: dict[str, Any] = {
            "status": "unchecked", "version": None, "models": [], "error": None,
            "web_available": False, "install_available": False, "login": "idle",
            "path": None, "relogin_available": self.consented(),
        }
        self._login: CodexRpc | None = None
        self._login_waiter: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    # A successful sign-in records consent, so an expired sign-in can be renewed
    # in one click. An explicit sign-out removes it and consent is asked again.
    def _consent_marker(self) -> Path:
        return self.root / "consent"

    def consented(self) -> bool:
        return self._consent_marker().is_file()

    def _record_consent(self, value: bool) -> None:
        marker = self._consent_marker()
        if value:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            marker.write_text("chatgpt\n", encoding="utf-8")
        else:
            marker.unlink(missing_ok=True)
        self.view["relogin_available"] = value

    def has_saved_login(self) -> bool:
        """A sign-in file exists in SKAZ's own profile (not proof it is still valid)."""
        return (self.root / "profile" / "auth.json").is_file() or self.consented()

    def environment(self) -> dict[str, str]:
        for name in ("home", "profile", "work", "tmp"):
            (self.root / name).mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self.location.child_path() if self.location else "/usr/bin:/bin"
        return {
            "HOME": str(self.root / "home"), "CODEX_HOME": str(self.root / "profile"),
            "TMPDIR": str(self.root / "tmp"), "LANG": "en_US.UTF-8", "PATH": path,
        }

    def rpc(self) -> CodexRpc:
        if self.binary is None:
            raise ValueError("Check the Codex connection first")
        command = [self.binary, "app-server", "--listen", "stdio://",
                   "-c", 'cli_auth_credentials_store="file"',
                   "-c", 'forced_login_method="chatgpt"', "-c", 'web_search="disabled"']
        for feature in DISABLED_FEATURES:
            command.extend(("-c", f"features.{feature}=false"))
        env = self.environment()
        return CodexRpc(tuple(command), cwd=self.cwd, env=env)

    async def check(self) -> dict[str, Any]:
        async with self._lock:
            # Only a first check shows progress; an explicit re-check keeps the known state.
            if self.view["status"] == "unchecked":
                self.view["status"] = "checking"
            try:
                self.location = locate_codex()
                self.binary = self.location.binary if self.location else None
                self.view["path"] = self.binary
                if self.binary is None:
                    self.view.update(status="missing", models=[], error="Codex is not installed")
                    return dict(self.view)
                env = self.environment()
                process = await asyncio.create_subprocess_exec(
                    self.binary, "--version", env=env, cwd=self.cwd,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    async with asyncio.timeout(5):
                        out, _ = await process.communicate()
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                version = out.decode().strip()
                self.view["version"] = version
                if version != "codex-cli 0.149.1":
                    self.view.update(status="incompatible", models=[], error="Verified version: 0.149.1")
                    return dict(self.view)
                async with self.rpc() as rpc:
                    account = await rpc.request("account/read", {"refreshToken": False})
                    if not account.get("account") or account["account"].get("type") != "chatgpt":
                        self.view.update(status="signed_out", models=[], error=None)
                        return dict(self.view)
                    models = []
                    cursor = None
                    for _ in range(20):
                        page = await rpc.request("model/list", {"cursor": cursor, "limit": 100})
                        for model in page["data"]:
                            if not model.get("hidden"):
                                models.append({"id": model["model"], "label": model["displayName"],
                                               "efforts": [e["reasoningEffort"]
                                                           for e in model["supportedReasoningEfforts"]]})
                        cursor = page.get("nextCursor")
                        if cursor is None:
                            break
                    else:
                        raise ValueError("Model catalog too large")
                    self.view.update(status="connected", models=models, error=None)
                    # SKAZ only signs in after consent, so a connected account proves it.
                    self._record_consent(True)
            except Exception:
                self.view.update(status="error", models=[], error="Codex connection failed; no fallback")
            return dict(self.view)

    async def login(self, consent: bool) -> str:
        if consent is not True and not self.consented():
            raise ValueError("Subscription privacy consent is required")
        if self.view["status"] not in ("signed_out", "connected"):
            raise ValueError("Check compatible Codex installation first")
        async with self._lock:
            # Signing in again replaces a page the user may have closed.
            await self._abandon_login()
            rpc = self.rpc()
            try:
                await rpc.__aenter__()
                result = await rpc.request("account/login/start", {"type": "chatgpt"})
                url = result["authUrl"]
                parsed = urlparse(url)
                if parsed.scheme != "https" or parsed.hostname != "auth.openai.com":
                    raise ValueError("Unexpected authorization origin")
                self._login = rpc
                self.view.update(login="pending", error=None)
                self._login_waiter = asyncio.create_task(self._wait_login(rpc))
                return str(url)
            except BaseException:
                await rpc.close()
                raise

    async def _wait_login(self, rpc: CodexRpc) -> None:
        outcome = "failed"
        try:
            async with asyncio.timeout(LOGIN_TIMEOUT_S):
                while True:
                    event = await rpc.next_event()
                    if event.get("method") == "account/login/completed":
                        params = event.get("params") or {}
                        # Codex's own error text is not shown: it is provider output.
                        outcome = "succeeded" if params.get("success") is True else "failed"
                        break
        except asyncio.CancelledError:
            outcome = "cancelled"
        except TimeoutError:
            outcome = "timed_out"
        except Exception:
            outcome = "failed"
        finally:
            await rpc.close()
            self._login = None
        if outcome != "succeeded":
            self.view.update(status="signed_out", models=[], login=outcome, error=LOGIN_FAILURES[outcome])
            return
        # Signed in: read the account and catalog now, so no manual check is needed.
        await self.check()
        if self.view["status"] == "signed_out":
            self.view.update(login="failed", error=LOGIN_FAILURES["failed"])
        else:
            self.view["login"] = "idle"

    async def logout(self) -> dict[str, Any]:
        await self.close()
        async with self._lock:
            async with self.rpc() as rpc:
                await rpc.request("account/logout", {})
            self._record_consent(False)
            self.view.update(status="signed_out", models=[], error=None, login="idle")
        return dict(self.view)

    async def close(self) -> None:
        # The waiter may be cancelled before it ever ran, so record the outcome here too.
        if self._login is not None:
            self.view.update(
                status="signed_out", models=[], login="cancelled", error=LOGIN_FAILURES["cancelled"]
            )
        await self._abandon_login()

    async def _abandon_login(self) -> None:
        if self._login_waiter is not None and not self._login_waiter.done():
            self._login_waiter.cancel()
            await asyncio.gather(self._login_waiter, return_exceptions=True)
        if self._login is not None:
            await self._login.close()
            self._login = None
