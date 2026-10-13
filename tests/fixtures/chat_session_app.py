"""Loopback-only HTTP fixture for real browser cookie acceptance; Atlas design §16.

No Gemini request or database access. Explicitly test-only signing key and selector.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from genomeos.chat.api import create_app
from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import Proposal

ROOT = Path(__file__).resolve().parents[2]


class FixtureSelector:
    async def select(self, body, metadata):
        await asyncio.sleep(0)
        return Proposal(
            operation="view",
            artifact_ids=[body.current_id],
            topic="measurement",
            metric="post_mean",
            layers=["observations", "support"],
            region="current",
        )


def create_test_app():
    catalog = PublishedCatalog.load(
        ROOT / "website/public/data/atlas/catalog.json", ROOT / "website/src/atlas/public-artifacts.json"
    )
    return create_app(
        catalog,
        FixtureSelector(),
        ["http://127.0.0.1:4335"],
        session_secret=b"test-only-browser-signing-key-not-for-deployment",
        session_secure=False,
    )
