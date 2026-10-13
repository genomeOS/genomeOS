"""Database-free assistant read API; Atlas design §§5, 13, 16.

Separate from genomeos.api so init_db, SQLAlchemy sessions, and scientific stores are unreachable.
GET returns admitted metadata. POST consumes a question and produces a response without
persistence. Signed browser credentials and session/address/global budgets isolate callers.
"""

from __future__ import annotations

import asyncio
import os
from collections import deque
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import ChatRequest, ChatResponse
from genomeos.chat.provider import GeminiSelector, Selector
from genomeos.chat.service import respond
from genomeos.chat.sessions import BrowserSessions


def create_app(
    catalog: PublishedCatalog,
    selector: Selector,
    origins: list[str],
    *,
    session_secret: bytes,
    session_secure: bool = True,
) -> FastAPI:
    for origin in origins:
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Chat origins must be explicit HTTP(S) origins")
        if not session_secure and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Non-Secure chat cookies are allowed only for loopback development")
    sessions = BrowserSessions(session_secret)
    cookie_name = "__Host-genomeos-chat" if session_secure else "genomeos-chat-dev"
    app = FastAPI(title="genomeOS published-map assistant", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )
    recent: deque[tuple[float, str, str]] = deque()
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
        response = await call_next(request)
        if request.url.path.startswith("/v1/atlas/chat"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def require_origin(request: Request) -> None:
        origin = request.headers.get("origin")
        # Same-origin GET fetches may omit Origin; POST always needs it.
        if origin is None and request.method == "GET":
            origin = f"{request.url.scheme}://{request.url.netloc}"
        if origin not in origins:
            raise HTTPException(403, "Chat request origin is not allowed")
        if not session_secure and request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise HTTPException(403, "Non-Secure session transport requires loopback")

    @app.get("/v1/atlas/chat/session")
    async def browser_session(request: Request, response: Response):
        require_origin(request)
        try:
            session = sessions.read(request.cookies.get(cookie_name))
        except ValueError:
            session = sessions.issue()
        # No Domain: browsers cannot share this cookie with another API host.
        response.set_cookie(
            cookie_name, session.cookie, httponly=True, secure=session_secure, samesite="lax", path="/"
        )
        response.headers["Vary"] = "Cookie, Origin"
        return {
            "session_id": session.identifier,
            "csrf_token": session.csrf_token,
            "expires_at": session.expires_at,
        }

    @app.get("/health")
    def health():
        return {"status": "ok", "database_access": False}

    @app.get("/v1/atlas/chat/catalog")
    def published_catalog():
        return {"revision": catalog.revision, "artifacts": catalog.metadata()}

    @app.post("/v1/atlas/chat", response_model=ChatResponse)
    async def chat(body: ChatRequest, request: Request):
        nonlocal active
        require_origin(request)
        try:
            session = sessions.read(request.cookies.get(cookie_name))
        except ValueError as exc:
            raise HTTPException(401, "Browser session missing or expired; reopen the assistant") from exc
        if not sessions.check_proof(session, request.headers.get("x-csrf-token")):
            raise HTTPException(403, "Browser session verification failed; reopen the assistant")
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
        if (
            len(recent) >= 20
            or sum(item[1] == address for item in recent) >= 12
            or sum(item[2] == session.identifier for item in recent) >= 6
            or active >= 2
        ):
            raise HTTPException(
                429, "Assistant budget reached; try again later", headers={"Retry-After": "60"}
            )
        recent.append((now, address, session.identifier))
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
    session_secret = os.environ.get("ATLAS_CHAT_SESSION_SECRET")
    if not catalog_path or not allowlist_path or not project or not session_secret:
        raise RuntimeError(
            "Configure catalog/allowlist paths, ATLAS_CHAT_GCP_PROJECT and ATLAS_CHAT_SESSION_SECRET"
        )
    catalog = PublishedCatalog.load(Path(catalog_path), Path(allowlist_path))
    selector = GeminiSelector(project, os.environ.get("ATLAS_CHAT_MODEL", "gemini-3.8-flash"))
    origins = os.environ.get("ATLAS_CHAT_ORIGINS", "http://localhost:4321").split(",")
    secure_setting = os.environ.get("ATLAS_CHAT_COOKIE_SECURE", "true")
    if secure_setting not in {"true", "false"}:
        raise ValueError("ATLAS_CHAT_COOKIE_SECURE must be true or false")
    return create_app(
        catalog,
        selector,
        origins,
        session_secret=session_secret.encode(),
        session_secure=secure_setting == "true",
    )
