"""Database-free assistant read API; Atlas design §§5, 13, 16.

Separate from genomeos.api so init_db, sessions, and scientific stores are unreachable.
GET returns admitted metadata. POST consumes a question and produces a response without
persistence. Fixed request, concurrency, global/per-address budgets bound model cost.
"""

from __future__ import annotations

import asyncio
import os
from collections import deque
from pathlib import Path
from time import monotonic

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import ChatRequest, ChatResponse
from genomeos.chat.provider import GeminiSelector, Selector
from genomeos.chat.service import respond


def create_app(catalog: PublishedCatalog, selector: Selector, origins: list[str]) -> FastAPI:
    app = FastAPI(title="genomeOS published-map assistant", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    recent: deque[tuple[float, str]] = deque()
    active = 0

    @app.middleware("http")
    async def bounded_body(request: Request, call_next):
        # Count actual bytes, including chunked bodies; do not trust Content-Length.
        if request.method == "POST":
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 24_000:
                    from starlette.responses import JSONResponse

                    return JSONResponse({"detail": "Request is too large"}, status_code=413)
            request._body = bytes(body)
        return await call_next(request)

    @app.get("/health")
    def health():
        return {"status": "ok", "database_access": False}

    @app.get("/v1/atlas/chat/catalog")
    def published_catalog():
        return {"revision": catalog.revision, "artifacts": catalog.metadata()}

    @app.post("/v1/atlas/chat", response_model=ChatResponse)
    async def chat(body: ChatRequest, request: Request):
        nonlocal active
        if body.catalog_revision != catalog.revision:
            raise HTTPException(409, "Catalog changed; reload the assistant")
        try:
            catalog.entry(body.current_id, body.current_version)
            if any(len(question) > 2000 for question in body.previous_questions):
                raise ValueError("Previous question is too long")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        now = monotonic()
        address = request.client.host if request.client else "unknown"
        while recent and now - recent[0][0] >= 60:
            recent.popleft()
        if len(recent) >= 20 or sum(item[1] == address for item in recent) >= 6 or active >= 2:
            raise HTTPException(
                429, "Assistant budget reached; try again later", headers={"Retry-After": "60"}
            )
        recent.append((now, address))
        active += 1
        try:
            async with asyncio.timeout(30):
                proposal = await selector.select(body, catalog.metadata())
                return respond(body, proposal, catalog)
        except ValueError as exc:
            raise HTTPException(422, "Unsupported assistant proposal; map unchanged") from exc
        except Exception as exc:
            # Never expose provider errors, access tokens or source prompts to clients/logs.
            raise HTTPException(503, "Assistant unavailable; map unchanged") from exc
        finally:
            active -= 1

    return app


def configured_app() -> FastAPI:
    """Composition boundary: explicit catalog paths and server-side GCP settings."""
    catalog_path = os.environ.get("ATLAS_CHAT_CATALOG_PATH")
    allowlist_path = os.environ.get("ATLAS_CHAT_ALLOWLIST_PATH")
    project = os.environ.get("ATLAS_CHAT_GCP_PROJECT")
    if not catalog_path or not allowlist_path or not project:
        raise RuntimeError(
            "Configure ATLAS_CHAT_CATALOG_PATH, ATLAS_CHAT_ALLOWLIST_PATH and ATLAS_CHAT_GCP_PROJECT"
        )
    catalog = PublishedCatalog.load(Path(catalog_path), Path(allowlist_path))
    selector = GeminiSelector(project, os.environ.get("ATLAS_CHAT_MODEL", "gemini-3.8-flash"))
    origins = os.environ.get("ATLAS_CHAT_ORIGINS", "http://localhost:4321").split(",")
    return create_app(catalog, selector, origins)
