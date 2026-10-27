"""Q1 n78 H-3: a link's host is compared with the user's sites the way a browser reads it.

Unicode (IDN) hosts, upper case, ideographic / fullwidth dots and fullwidth letters match their
punycode list entries; links whose authority a browser would parse differently from Python's
``urlsplit`` (a backslash, userinfo, percent-escapes) are no clean links at all.
"""
from __future__ import annotations

import pytest

from skaz.knowledge.agents.web import WebLink, clean_links
from skaz.knowledge.permissions.search_rules import WebRules, active_rules, host_of, screen, sites

NEVER = active_rules(WebRules(never=sites(["пример.рф", "bad.com"])), None)
ONLY = active_rules(WebRules(only_on=True, only=sites(["x.org"])), None)


@pytest.mark.parametrize("url", [
    "https://пример.рф/a", "https://ПРИМЕР.РФ/a", "https://www.пример.рф/a", "https://sub.пример.рф/",
    "https://xn--e1afmkfd.xn--p1ai/a", "https://bad。com/", "https://bad．com/", "https://ｂａｄ.com/",
    "https://BAD.com./",
])
def test_unicode_and_lookalike_hosts_are_held_by_never(url: str) -> None:
    assert screen([WebLink("t", url)], NEVER).kept == ()


@pytest.mark.parametrize("url", [
    "https://bad.com\\@x.org/", "https://user@x.org/", "https://bad.com%2f@x.org/", "https://x.org\\.bad.com/",
])
def test_links_a_browser_reads_differently_are_dropped(url: str) -> None:
    assert clean_links([WebLink("t", url)]) == ()
    assert host_of(url) == ""
    assert screen([WebLink("t", url)], ONLY).kept == ()


def test_plain_hosts_still_pass() -> None:
    links = [WebLink("t", "https://docs.x.org/p?q=1"), WebLink("u", "https://example.com/")]
    kept = screen(links, NEVER).kept
    assert [link.url for link in kept] == ["https://docs.x.org/p?q=1", "https://example.com/"]
    assert host_of("https://Пример.РФ:8080/x") == "xn--e1afmkfd.xn--p1ai"
    assert screen([WebLink("t", "https://docs.x.org/")], ONLY).kept != ()
