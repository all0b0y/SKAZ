"""Security review 0.3.1, S-02 / S-03 / S-05: where ``SafeFetcher`` may connect.

No network: the resolver and the transport are fakes; requests are recorded as
``(connected host, Host header, path)``.

* S-03: numeric host forms (``http://3323068417/``, ``http://198.18.1/``, hex, octal) are literal
  addresses — the literal policy applies and the name resolver is never asked.
* S-02 (user decision 2026-10-22): a VPN fake-IP answer (198.18.0.0/15) is accepted only when the
  caller says the request comes from the user's click (``allow_vpn_fake_ip=True``: Add to wiki of a
  web page, Add link and its link check), only for a real public domain name, only on the default
  port. Automatic follow-up requests (the oEmbed lookup) never get it.
* S-05: every caller connects to the very address it checked (DNS rebinding), keeping the name in
  ``Host``.
"""
from __future__ import annotations

import httpx
import pytest

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.fetch import LinkRejected, SafeFetcher, check_url
from skaz.knowledge.sources.links import classify_link
from skaz.knowledge.sources.service import SourceService

from .test_web_page_snapshot import ARTICLE

PUBLIC = "93.184.216.34"
FAKE = "198.18.0.192"
Hit = tuple[str, str, str]
OEMBED_PAGE = (
    "<html><head><title>Clip</title>"
    "<link rel='alternate' type='application/json+oembed' href='/oembed?u=1'></head><body></body></html>"
)


class Dns:
    """A fake resolver: one answer for every name, and the names it was asked."""

    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.asked: list[str] = []

    async def __call__(self, host: str) -> list[str]:
        self.asked.append(host)
        return [self.answer]


def site(hits: list[Hit], pages: dict[str, httpx.Response] | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        hits.append((request.url.host, request.headers["host"], request.url.path))
        if pages and request.url.path in pages:
            return pages[request.url.path]
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=ARTICLE)

    return httpx.MockTransport(handler)


def fetcher_for(answer: str, hits: list[Hit], pages: dict[str, httpx.Response] | None = None
                ) -> tuple[SafeFetcher, Dns]:
    dns = Dns(answer)
    return SafeFetcher(transport=site(hits, pages), resolver=dns), dns


# -- S-03: numeric host forms are literals -----------------------------------------------------

NUMERIC_NOT_PUBLIC = [
    "http://3323068417/",  # 198.18.0.1 as one number
    "http://198.18.1/",  # 198.18.0.1, short dotted form
    "http://0xC6120001/",  # 198.18.0.1 in hex
    "http://0300.0250.0.1/",  # 192.168.0.1 in octal
    "http://0xc0.0xa8.0.1/",  # 192.168.0.1, dotted hex
    "http://2130706433/",  # 127.0.0.1
    "http://127.1/",
    "http://0x7f000001:8765/",
]


@pytest.mark.parametrize("url", NUMERIC_NOT_PUBLIC)
def test_numeric_host_forms_are_literal_addresses_and_refused(url: str) -> None:
    with pytest.raises(LinkRejected):
        check_url(url)


async def test_numeric_hosts_never_reach_the_resolver_so_a_fake_ip_answer_cant_let_them_through() -> None:
    hits: list[Hit] = []
    fetcher, dns = fetcher_for(FAKE, hits)
    for url in NUMERIC_NOT_PUBLIC:
        for user_click in (False, True):
            with pytest.raises(LinkRejected):
                await fetcher.fetch(url, pin_address=True, allow_vpn_fake_ip=user_click)
    assert dns.asked == [] and hits == []


async def test_a_public_numeric_form_follows_the_literal_policy_without_dns() -> None:
    hits: list[Hit] = []
    fetcher, dns = fetcher_for(FAKE, hits)
    fetched = await fetcher.fetch("http://134744072/page", pin_address=True)  # 8.8.8.8
    assert fetched.status == 200 and dns.asked == []


# -- S-02: the fake-IP exception ----------------------------------------------------------------


async def test_a_fake_ip_answer_is_refused_unless_the_caller_passes_the_user_click_flag() -> None:
    hits: list[Hit] = []
    fetcher, _dns = fetcher_for(FAKE, hits)
    with pytest.raises(LinkRejected, match="VPN hides"):
        await fetcher.fetch("https://opengroup.org/togaf", pin_address=True)
    assert hits == []
    fetched = await fetcher.fetch("https://opengroup.org/togaf", pin_address=True, allow_vpn_fake_ip=True)
    assert fetched.status == 200 and hits == [(FAKE, "opengroup.org", "/togaf")]


@pytest.mark.parametrize("url", [
    "https://router.lan/", "https://printer.home/", "https://intranet/", "https://wpad/",
    "https://box.localdomain/", "https://wiki.intranet/", "https://git.corp/", "https://nas.private/",
    "https://site.test/", "https://site.invalid/", "https://www.example/", "https://name.123/",
    "https://ROUTER.LAN./", "https://home.arpa/",
    "https://opengroup.org:8443/", "http://opengroup.org:8080/", "https://opengroup.org:80/",
    "http://opengroup.org:443/",
])
async def test_the_fake_ip_exception_needs_a_public_domain_name_on_the_default_port(url: str) -> None:
    hits: list[Hit] = []
    fetcher, _dns = fetcher_for(FAKE, hits)
    with pytest.raises(LinkRejected):
        await fetcher.fetch(url, pin_address=True, allow_vpn_fake_ip=True)
    assert hits == []


@pytest.mark.parametrize("url", [
    "https://opengroup.org:443/x", "http://opengroup.org:80/x", "https://www.bbc.co.uk/news",
    "http://habr.com/ru/articles/1/",
])
async def test_public_names_on_default_ports_pass_with_the_flag(url: str) -> None:
    hits: list[Hit] = []
    fetcher, _dns = fetcher_for(FAKE, hits)
    fetched = await fetcher.fetch(url, pin_address=True, allow_vpn_fake_ip=True)
    assert fetched.status == 200 and hits[0][0] == FAKE


async def test_each_redirect_hop_is_held_to_the_same_fake_ip_rules() -> None:
    hits: list[Hit] = []
    pages = {"/a": httpx.Response(302, headers={"location": "http://opengroup.org:8080/b"}),
             "/c": httpx.Response(302, headers={"location": "http://router/admin"})}
    fetcher, _dns = fetcher_for(FAKE, hits, pages)
    for path in ("/a", "/c"):
        with pytest.raises(LinkRejected):
            await fetcher.fetch(f"https://opengroup.org{path}", pin_address=True, allow_vpn_fake_ip=True)
    assert [hit[2] for hit in hits] == ["/a", "/c"]


async def test_user_click_paths_accept_a_fake_ip_and_automatic_lookups_do_not(
    ready: KnowledgeService,
) -> None:
    hits: list[Hit] = []
    pages = {"/clip": httpx.Response(200, headers={"content-type": "text/html"}, text=OEMBED_PAGE),
             "/oembed": httpx.Response(200, json={"type": "video", "duration": 61})}
    fetcher, _dns = fetcher_for(FAKE, hits, pages)
    service = SourceService(ready, fetcher=fetcher)
    # Add link (and the link check of the Add link dialog), Add to wiki of a web page: the user's click.
    added = await service.add_link("https://blog.example.org/heat", INBOX_ID)
    assert added.material_id
    saved = await service.add_web_page("https://notes.example.org/heat", INBOX_ID)
    assert saved.material_id
    hits.clear()
    info = await service.classify("https://media.example.org/clip", probe=False)
    # The page was read; its oEmbed address comes from the page, not the user: no fake-IP exception.
    assert info.kind == "site" and [hit[2] for hit in hits] == ["/clip"]
    # The plain link check (no user click passed down) keeps refusing fake-IP answers.
    with pytest.raises(LinkRejected):
        await classify_link("https://media.example.org/clip", fetcher)


# -- S-05: every caller is pinned to the checked address -----------------------------------------


async def test_add_link_and_link_checks_connect_to_the_checked_address(ready: KnowledgeService) -> None:
    hits: list[Hit] = []
    pages = {"/clip": httpx.Response(200, headers={"content-type": "text/html"}, text=OEMBED_PAGE),
             "/oembed": httpx.Response(200, json={"type": "video", "duration": 61})}
    fetcher, dns = fetcher_for(PUBLIC, hits, pages)
    service = SourceService(ready, fetcher=fetcher)
    await service.add_link("https://blog.example/heat", INBOX_ID)
    await service.classify("https://blog.example/heat", probe=False)
    info = await classify_link("https://media.example/clip", fetcher)
    assert info.kind == "video"  # the oEmbed lookup ran, pinned as well
    assert hits == [(PUBLIC, "blog.example", "/heat"), (PUBLIC, "blog.example", "/heat"),
                    (PUBLIC, "media.example", "/clip"), (PUBLIC, "media.example", "/oembed")]
    assert dns.asked == ["blog.example", "blog.example", "media.example", "media.example"]
