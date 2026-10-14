"""Domain errors with a plain-English message (the UI is English-only) and an HTTP status."""
from __future__ import annotations

NAME_TAKEN = "An item with this name already exists. Choose another name."


class KnowledgeError(Exception):
    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NameRejected(KnowledgeError):
    status_code = 422


class NameTaken(KnowledgeError):
    status_code = 409

    def __init__(self, message: str = NAME_TAKEN) -> None:
        super().__init__(message)


class NotFound(KnowledgeError):
    status_code = 404


class ProtectedItem(KnowledgeError):
    status_code = 409


class FolderNotEmpty(KnowledgeError):
    status_code = 409

    def __init__(self, message: str = "This folder still has materials. Move or delete them first.") -> None:
        super().__init__(message)


class LibraryUnavailable(KnowledgeError):
    """The root is missing, unreadable, foreign or replaced. Never means "empty library"."""

    status_code = 503


class LibraryConflict(KnowledgeError):
    """The chosen place cannot hold a new library (foreign content, outside the sandbox)."""

    status_code = 409
