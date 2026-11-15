"""The free/paid line's constants (Atlas data platform design 2026-10-18 §4.2, §4.3).

One pure module holds what serving costs and the caps derived from it, so the release build, the
release guard and the cost report cannot disagree. Phase 1 publishes every object ``open`` from our own
bucket: no paid door (R5–R7) and no zero-egress mirror exists yet, so an object outside ``OPEN_CLASSES``
is published only while it stays within ``OPEN_OBJECT_MAX_BYTES`` (step 1.8 applies that to the raw
harvests, ``raw_harvests.check_raw_harvests``). No I/O and no network.
"""

from __future__ import annotations

from decimal import Decimal

#: GCS internet egress, 0–10 TiB, in US dollars per GiB.
EGRESS_USD_PER_GIB = Decimal("0.12")
#: The largest object free to download whole outside ``OPEN_CLASSES``: one download costs us at most
#: $0.12, while a $10 card top-up loses $0.59 to Stripe's 2.9% + 30¢ (§4.2).
OPEN_OBJECT_MAX_BYTES = 1 << 30
#: A release's free whole-file bytes that no zero-egress host holds, R5 bytes included (§4.2, the guard).
OPEN_RELEASE_GCS_MAX_BYTES = 2 << 30
#: The lookup bucket's daily brake (D16).
LOOKUP_DAILY_BYTES_MAX = 20 << 30
