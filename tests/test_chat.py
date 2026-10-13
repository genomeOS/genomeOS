"""Scientific refusal, admission and database immutability acceptance for design §16."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from genomeos.chat.api import create_app
from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import ChatRequest, Proposal
from genomeos.chat.service import respond

ROOT = Path(__file__).resolve().parents[1]
TEST_SESSION_SECRET = b"test-only-session-signing-key-not-for-deployment"


@pytest.fixture
def catalog():
    return PublishedCatalog.load(
        ROOT / "website/public/data/atlas/catalog.json", ROOT / "website/src/atlas/public-artifacts.json"
    )


def request(catalog, **changes):
    return ChatRequest(
        message="Show HbS observations in West Africa",
        catalog_revision=catalog.revision,
        state_token="immutable-browser-state",
        current_id="hbs-rs334",
        current_version="v3/map-2026-08",
        **changes,
    )


def proposal(**changes):
    return Proposal(
        **{
            "operation": "view",
            "artifact_ids": ["hbs-rs334"],
            "topic": "measurement",
            "metric": "post_mean",
            "layers": ["observations"],
            "region": "west-africa",
            **changes,
        }
    )


def test_exact_published_identity_and_mandatory_support(catalog):
    response = respond(request(catalog), proposal(), catalog)
    assert response.action.selections[0].version == "v3/map-2026-08"
    assert response.action.layers == ["observations", "support"]
    assert response.action.state_token == "immutable-browser-state"
    assert "not yet been confirmed" in response.answer
    assert response.sources


def test_comparison_preserves_different_denominators(catalog):
    response = respond(
        request(catalog),
        proposal(operation="compare", artifact_ids=["hbs-rs334", "g6pd-deficiency"]),
        catalog,
    )
    assert "HbS allele" in response.answer
    assert "hemizygous males" in response.answer
    assert len(response.action.selections) == 2


@pytest.mark.parametrize("identifier", ["alphaearth", "iq", "height", "nonexistent", "../../genomeos.db"])
def test_unadmitted_datasets_cannot_become_actions(catalog, identifier):
    with pytest.raises(ValueError):
        respond(request(catalog), proposal(artifact_ids=[identifier]), catalog)


def test_scope_cannot_express_writes_sql_urls_or_generated_claims():
    for value in ["delete", "insert", "sql", "fetch", "fit", "burden", "correlation"]:
        with pytest.raises(ValidationError):
            proposal(operation=value)
    with pytest.raises(ValidationError):
        Proposal(**{**proposal().model_dump(), "answer": "invented scientific result"})


def test_uncertainty_refusal_and_versions(catalog):
    response = respond(request(catalog), proposal(operation="explain", topic="uncertainty"), catalog)
    assert response.action is None
    assert "Unknown and prior-dominated" in response.answer
    assert "correlation or pleiotropy" in response.answer
    refused = respond(request(catalog), proposal(operation="refuse"), catalog)
    assert refused.action is None
    with pytest.raises(ValueError):
        respond(
            request(catalog).model_copy(update={"current_version": "v99/unpublished"}), proposal(), catalog
        )
    with pytest.raises(ValueError):
        respond(request(catalog).model_copy(update={"catalog_revision": "0" * 64}), proposal(), catalog)


def test_publication_allowlist_is_required():
    raw = json.loads((ROOT / "website/public/data/atlas/catalog.json").read_text())
    allowed = json.loads((ROOT / "website/src/atlas/public-artifacts.json").read_text())
    changed = copy.deepcopy(raw)
    changed["artifacts"][0]["model_version"] = "unreviewed"
    with pytest.raises(ValueError):
        PublishedCatalog(changed, allowed)
    changed = copy.deepcopy(raw)
    changed["artifacts"][0]["id"] = "candidate-only"
    with pytest.raises(ValueError):
        PublishedCatalog(changed, allowed)


class FakeSelector:
    def __init__(self, result=None):
        self.calls = 0
        self.result = result or proposal()

    async def select(self, body, metadata):
        self.calls += 1
        return self.result


def test_http_boundary_no_database_writes_and_budgets(catalog, tmp_path, monkeypatch):
    sentinel = tmp_path / "science.db"
    sentinel.write_bytes(b"scientific database must remain untouched")
    before = hashlib.sha256(sentinel.read_bytes()).digest()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{sentinel}")
    fake = FakeSelector()
    app = create_app(catalog, fake, ["https://genome-os.org"], session_secret=TEST_SESSION_SECRET)

    async def check():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://genome-os.org",
            headers={"Origin": "https://genome-os.org"},
        ) as client:
            assert (await client.get("/health")).json()["database_access"] is False
            assert (await client.get("/v1/atlas/chat/catalog")).json()["revision"] == catalog.revision
            body = request(catalog).model_dump()
            session = (await client.get("/v1/atlas/chat/session")).json()
            client.headers["X-CSRF-Token"] = session["csrf_token"]
            assert (
                await client.post("/v1/atlas/chat", json={**body, "sql": "DELETE FROM associations"})
            ).status_code == 422
            assert (
                await client.post("/v1/atlas/chat", json={**body, "catalog_revision": "0" * 64})
            ).status_code == 409
            assert fake.calls == 0
            assert (await client.post("/v1/atlas/chat", content=b"x" * 24_001)).status_code == 413
            for _ in range(6):
                assert (await client.post("/v1/atlas/chat", json=body)).status_code == 200
            assert (await client.post("/v1/atlas/chat", json=body)).status_code == 429
            for method in ["put", "patch", "delete"]:
                assert (await getattr(client, method)("/v1/atlas/chat")).status_code == 405

    asyncio.run(check())
    assert hashlib.sha256(sentinel.read_bytes()).digest() == before
    assert sorted(item.name for item in tmp_path.iterdir()) == ["science.db"]


def test_chat_import_has_no_database_or_science_dependency():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import genomeos.chat.api; "
                "assert not any(name in sys.modules for name in "
                "['sqlalchemy', 'genomeos.db', 'genomeos.api', 'pymc', 'duckdb'])"
            ),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_invalid_provider_action_and_provider_failure_are_bounded(catalog):
    class BrokenSelector:
        async def select(self, *args):
            raise RuntimeError("secret-token-provider-error")

    async def check():
        for selector, expected in [
            (FakeSelector(proposal(artifact_ids=["alphaearth"])), 422),
            (BrokenSelector(), 503),
        ]:
            app = create_app(catalog, selector, ["https://genome-os.org"], session_secret=TEST_SESSION_SECRET)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="https://genome-os.org",
                headers={"Origin": "https://genome-os.org"},
            ) as client:
                session = (await client.get("/v1/atlas/chat/session")).json()
                client.headers["X-CSRF-Token"] = session["csrf_token"]
                result = await client.post("/v1/atlas/chat", json=request(catalog).model_dump())
                assert result.status_code == expected
                assert "secret-token" not in result.text

    asyncio.run(check())
