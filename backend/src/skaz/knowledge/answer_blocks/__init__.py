"""Answer blocks (P1): ready-made blocks the agent fills with JSON data and SKAZ draws.

The agent never writes HTML: it writes a fenced ```` ```skaz-block {json} ``` ```` in its answer;
the backend validates it against the block's strict schema and checks every item's source
before anything is drawn. One block type = one schema module + one line in ``registry``.

This package does not import ``chats`` (``chats`` imports it): the chat-side glue that checks
ids against the library lives in ``chats.blocks``.
"""
