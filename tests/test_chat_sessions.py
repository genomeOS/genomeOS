"""Anonymous-browser separation, proof and expiry acceptance; Atlas design §16."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from genomeos.chat.api import create_app
from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import Proposal
from genomeos.chat.sessions import SESSION_LIFETIME_SECONDS, BrowserSessions

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://genome-os.org"
TEST_SECRET = b"test-only-session-signing-key-not-for-deployment"


class RecordingSelector:
    def __init__(self):
        self.questions = []

    async def select(self, body, metadata):
        await asyncio.sleep(0)
        self.questions.append((body.message, list(body.previous_questions)))
        return Proposal(
            operation="view",
            artifact_ids=[body.current_id],
            topic="measurement",
            metric="post_mean",
            layers=["observations", "support"],
            region="current",
        )


def make_app(secret=TEST_SECRET):
    catalog = PublishedCatalog.load(
        ROOT / "website/public/data/atlas/catalog.json", ROOT / "website/src/atlas/public-artifacts.json"
    )
    selector = RecordingSelector()
    app = create_app(catalog, selector, [ORIGIN], session_secret=secret)
    body = {
        "message": "question",
        "catalog_revision": catalog.revision,
        "state_token": "own-map-state",
        "current_id": "hbs-rs334",
        "current_version": "v3/map-2026-08",
        "previous_questions": [],
    }
    return app, selector, body


def client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN, headers={"Origin": ORIGIN}
    )


async def bootstrap(browser):
    response = await browser.get("/v1/atlas/chat/session")
    assert response.status_code == 200
    data = response.json()
    browser.headers["X-CSRF-Token"] = data["csrf_token"]
    return data, response


def test_browser_ids_are_separate_stable_and_private():
    app, _, _ = make_app()

    async def check():
        async with client(app) as alice, client(app) as bob:
            first, response = await bootstrap(alice)
            other, _ = await bootstrap(bob)
            again, _ = await bootstrap(alice)
            assert first == again
            assert first["session_id"] != other["session_id"]
            assert first["csrf_token"] != other["csrf_token"]
            cookie = response.headers["set-cookie"]
            assert cookie.startswith("__Host-genomeos-chat=")
            for flag in ["HttpOnly", "Secure", "SameSite=lax", "Path=/"]:
                assert flag in cookie
            assert "Domain=" not in cookie
            assert response.headers["cache-control"] == "no-store"
            assert "Cookie" in response.headers["vary"]

    asyncio.run(check())


def test_one_browser_cannot_select_or_prove_another_browsers_session():
    app, selector, body = make_app()

    async def check():
        async with client(app) as alice, client(app) as bob, client(app) as stranger:
            a, _ = await bootstrap(alice)
            b, _ = await bootstrap(bob)
            assert (await stranger.post("/v1/atlas/chat", json=body)).status_code == 401
            assert (
                await alice.post("/v1/atlas/chat", json=body, headers={"X-CSRF-Token": b["csrf_token"]})
            ).status_code == 403
            assert (
                await alice.post("/v1/atlas/chat", json={**body, "session_id": b["session_id"]})
            ).status_code == 422
            # Knowing the public ID is insufficient to forge its signed HttpOnly credential.
            forged = f"v1.{b['session_id']}.1." + "0" * 64
            stranger.cookies.set("__Host-genomeos-chat", forged, domain="genome-os.org", path="/")
            assert (
                await stranger.post("/v1/atlas/chat", json=body, headers={"X-CSRF-Token": b["csrf_token"]})
            ).status_code == 401
            assert not selector.questions
            # Concurrent visitors send only their own transient context and map state.
            results = await asyncio.gather(
                alice.post(
                    "/v1/atlas/chat",
                    json={
                        **body,
                        "message": "Alice",
                        "previous_questions": ["Alice earlier"],
                        "state_token": "Alice-map",
                    },
                ),
                bob.post(
                    "/v1/atlas/chat",
                    json={
                        **body,
                        "message": "Bob",
                        "previous_questions": ["Bob earlier"],
                        "state_token": "Bob-map",
                    },
                ),
            )
            assert [res.status_code for res in results] == [200, 200]
            assert [res.json()["action"]["state_token"] for res in results] == ["Alice-map", "Bob-map"]
            assert sorted(selector.questions) == [("Alice", ["Alice earlier"]), ("Bob", ["Bob earlier"])]
            assert alice.headers["X-CSRF-Token"] == a["csrf_token"]
            assert (await alice.get("/v1/atlas/chat/history")).status_code == 404

    asyncio.run(check())


def test_sessions_have_separate_budgets_on_the_same_ip():
    app, _, body = make_app()

    async def check():
        async with client(app) as alice, client(app) as bob:
            await bootstrap(alice)
            await bootstrap(bob)
            for _ in range(6):
                assert (await alice.post("/v1/atlas/chat", json=body)).status_code == 200
            assert (await alice.post("/v1/atlas/chat", json=body)).status_code == 429
            assert (await bob.post("/v1/atlas/chat", json=body)).status_code == 200

    asyncio.run(check())


def test_untrusted_or_missing_post_origin_never_reaches_the_provider():
    app, selector, body = make_app()

    async def check():
        async with client(app) as browser:
            await bootstrap(browser)
            for origin in ["https://evil.invalid", "null"]:
                assert (
                    await browser.post("/v1/atlas/chat", json=body, headers={"Origin": origin})
                ).status_code == 403
                assert (
                    await browser.get("/v1/atlas/chat/session", headers={"Origin": origin})
                ).status_code == 403
            del browser.headers["Origin"]
            assert (await browser.post("/v1/atlas/chat", json=body)).status_code == 403
            assert not selector.questions
            # Same-origin GET fetches are allowed to omit Origin.
            assert (await browser.get("/v1/atlas/chat/session")).status_code == 200

    asyncio.run(check())


def test_expiry_tampering_and_key_rotation_do_not_silently_switch_a_chat():
    now = [1000.0]
    sessions = BrowserSessions(TEST_SECRET, clock=lambda: now[0])
    first = sessions.issue()
    assert sessions.read(first.cookie).identifier == first.identifier
    now[0] += SESSION_LIFETIME_SECONDS
    with pytest.raises(ValueError, match="expired"):
        sessions.read(first.cookie)
    now[0] = 1000.0
    with pytest.raises(ValueError):
        sessions.read(first.cookie + "x")
    changed_key = BrowserSessions(b"different-test-only-signing-key-000", clock=lambda: now[0])
    with pytest.raises(ValueError):
        changed_key.read(first.cookie)
    assert not sessions.check_proof(first, "invalid")
    assert not sessions.check_proof(first, sessions.issue().csrf_token)


def test_signing_key_is_explicit_shared_and_insecure_cookies_are_loopback_only():
    with pytest.raises(ValueError):
        BrowserSessions(b"short")
    session = BrowserSessions(TEST_SECRET).issue()
    assert BrowserSessions(TEST_SECRET).read(session.cookie).identifier == session.identifier
    app, selector, _ = make_app()
    catalog = PublishedCatalog.load(
        ROOT / "website/public/data/atlas/catalog.json", ROOT / "website/src/atlas/public-artifacts.json"
    )
    with pytest.raises(ValueError):
        create_app(catalog, selector, [ORIGIN], session_secret=TEST_SECRET, session_secure=False)
    with pytest.raises(ValueError):
        create_app(catalog, selector, ["*"], session_secret=TEST_SECRET)
