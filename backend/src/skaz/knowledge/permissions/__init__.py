"""Agent controls of 0.3.1 phase P: permission requests, agents' questions, waits.

* ``store`` — the service tables (``permission_requests``, ``permission_grants``,
  ``agent_questions`` in ``knowledge.sqlite3``, schema ``chats`` v2).
* ``broker`` — :class:`PermissionBroker`: a wiki change by an agent waits for the
  user's Allow / Allow in this chat / Deny, without a timeout, until Stop.
* ``questions`` — :class:`QuestionBroker`: an agent's question waits the same way.
* ``waits`` — which runs are waiting for the user (their answer deadline stands still).
* ``wiki_tools`` — the four wiki tools that go through the broker.
* ``refusals`` — the silent refusal of native permission requests (A-1).

Logs carry ids, kinds, engines and states only — never block text, reasons or answers.
"""
