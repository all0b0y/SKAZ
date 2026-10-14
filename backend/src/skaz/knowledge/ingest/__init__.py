"""Ingest (area W1): one material → its Notes page + Concept pages, written by SKAZ code.

The model never writes files and has no tools (poisoning layer 1). It returns
structured statements; code checks them (layer 4: verbatim quotes of existing,
not excluded fragments; layer 5: no instructions to an AI in the output) and
only then writes Markdown. Source text reaches the model only as untrusted
data (layer 6).
"""
