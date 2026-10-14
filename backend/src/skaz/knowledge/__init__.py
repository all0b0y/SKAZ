"""SKAZ Knowledge Wiki: Markdown library as the primary copy, SQLite as a rebuildable index.

Subpackages: ``store`` (database, schema registry, repositories), ``library``
(layout, names, files), ``markdown`` (source and page formats), ``index``
(scan, rebuild, FTS5 search), ``agents`` (engine interface), ``api`` (routers).
This package never imports the legacy session/notes modules.
"""
