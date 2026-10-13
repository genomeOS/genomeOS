"""Stateless anonymous browser credentials; Atlas design §16.

Claim: visitors have separate identities without a login or a server conversation store.
Acceptance: stable browser cookies, distinct profiles, expiry and tampering refusal.
Interface: issue/read/proof over a signed opaque cookie; the HTTP adapter owns transport.
Assumptions: possession of the cookie identifies a browser profile, not a person. Tabs
share that identity but keep separate transcripts. Security entropy is cryptographic,
never seeded by the scientific random-number generator. No database or file access.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

SESSION_LIFETIME_SECONDS = 24 * 60 * 60
COOKIE_PATTERN = re.compile(r"v1\.([a-f0-9]{64})\.([0-9]{1,12})\.([a-f0-9]{64})")


@dataclass(frozen=True, repr=False)
class BrowserSession:
    identifier: str
    cookie: str
    expires_at: int
    csrf_token: str


class BrowserSessions:
    def __init__(self, secret: bytes, clock: Callable[[], float] = time.time) -> None:
        if len(secret) < 32:
            raise ValueError("The chat session signing secret must contain at least 32 bytes")
        self._secret = secret
        self._clock = clock

    def _mac(self, purpose: str, value: str) -> str:
        return hmac.new(self._secret, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()

    def _credentials(self, identifier: str, issued_at: int, cookie: str) -> BrowserSession:
        return BrowserSession(
            identifier, cookie, issued_at + SESSION_LIFETIME_SECONDS, self._mac("csrf", cookie)
        )

    def issue(self) -> BrowserSession:
        identifier = secrets.token_hex(32)
        issued_at = int(self._clock())
        payload = f"v1.{identifier}.{issued_at}"
        cookie = f"{payload}.{self._mac('cookie', payload)}"
        return self._credentials(identifier, issued_at, cookie)

    def read(self, cookie: str | None) -> BrowserSession:
        match = COOKIE_PATTERN.fullmatch(cookie or "")
        if not match:
            raise ValueError("A valid browser session is required")
        identifier, timestamp, signature = match.groups()
        issued_at = int(timestamp)
        payload = f"v1.{identifier}.{timestamp}"
        if not hmac.compare_digest(signature, self._mac("cookie", payload)):
            raise ValueError("A valid browser session is required")
        now = int(self._clock())
        if issued_at > now or now >= issued_at + SESSION_LIFETIME_SECONDS:
            raise ValueError("Browser session expired")
        return self._credentials(identifier, issued_at, cookie)

    @staticmethod
    def check_proof(session: BrowserSession, token: str | None) -> bool:
        return bool(
            token and re.fullmatch(r"[a-f0-9]{64}", token) and hmac.compare_digest(session.csrf_token, token)
        )
