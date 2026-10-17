"""The version of the Python→web Atlas data format (Atlas design §11, §12; fast-load and GCS design
2026-10-07 §B.4, amended by #467; rules in ``docs/web-data-format.md``).

``catalog.json`` declares ``format_version`` as ``"MAJOR.MINOR"``, and that is the one place the
format's version lives. The catalog is committed and deployed with the site (§B.4 ruling), so a
version change never touches the immutable, content-addressed bucket objects (§C.2). Each of those
keeps its own per-object slot (the GOSA and GOBD u16 ``format_version``, the JSON ``schema_version``),
and the format MAJOR fixes the value every slot must hold.

Who checks what:

- **Writers** (``export_atlas_web.py`` stamps the version; ``encode_atlas_web.py`` and the fixture
  builders that go through it) emit exactly ``WEB_FORMAT_VERSION`` and refuse anything else:
  ``require_current``.
- **Python readers that enumerate every object a catalog names** (``web_layout``, hence the
  publisher and the deploy gate) refuse another MAJOR, and a newer MINOR whose keys they cannot
  know: ``require_known``.
- **The browser** (``website/src/atlas/format-version.ts``) refuses another MAJOR and reads a newer
  MINOR, ignoring catalog keys it does not know.

There is no default (design §12): a catalog without ``format_version`` is refused, never read as 1.0.
Pure: standard library only, no I/O.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

#: The format this code writes. Bump it per docs/web-data-format.md. ``tests/test_web_format.py``
#: and ``website/tests/atlas-format-version.test.ts`` hold the TypeScript constant and every committed
#: catalog to this value.
WEB_FORMAT_VERSION = "1.0"
FIELD = "format_version"

# ASCII digits only and no leading zeros, so one version has exactly one spelling.
_VERSION = re.compile(r"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})")


class WebFormatError(ValueError):
    """A catalog whose format version is missing, malformed or not one this code handles. Fatal."""


def parse_format_version(value: object) -> tuple[int, int]:
    """``(major, minor)`` for a ``"MAJOR.MINOR"`` string; anything else is refused, not coerced."""
    if not isinstance(value, str) or not _VERSION.fullmatch(value):
        raise WebFormatError(
            f'format_version {value!r} is not a "MAJOR.MINOR" string such as "1.0" '
            "(docs/web-data-format.md)"
        )
    major, minor = value.split(".")
    return int(major), int(minor)


CURRENT = parse_format_version(WEB_FORMAT_VERSION)


def catalog_format_version(catalog: object) -> tuple[int, int]:
    """The version ``catalog`` declares. A catalog that declares none is refused."""
    if not isinstance(catalog, Mapping):
        raise WebFormatError(f"the catalog is not a JSON object (got {type(catalog).__name__})")
    if FIELD not in catalog:
        raise WebFormatError(
            "the catalog declares no format_version (docs/web-data-format.md); one that still carries "
            "the pre-#467 schema_version predates format versioning and must be re-exported"
        )
    return parse_format_version(catalog[FIELD])


def require_current(catalog: object) -> None:
    """For writers: ``catalog`` must declare exactly ``WEB_FORMAT_VERSION``."""
    major, minor = catalog_format_version(catalog)
    if (major, minor) != CURRENT:
        raise WebFormatError(
            f"catalog format_version {major}.{minor} is not {WEB_FORMAT_VERSION}, the format this code "
            "writes; re-export it with the current scripts/export_atlas_web.py"
        )


def require_known(catalog: object) -> tuple[int, int]:
    """For Python readers that must see every object key: the same MAJOR, and no newer MINOR."""
    major, minor = catalog_format_version(catalog)
    current = f"{CURRENT[0]}.{CURRENT[1]}"
    if major != CURRENT[0]:
        raise WebFormatError(
            f"catalog format_version {major}.{minor} has MAJOR {major}; this code reads MAJOR "
            f"{CURRENT[0]} only (docs/web-data-format.md)"
        )
    if minor > CURRENT[1]:
        raise WebFormatError(
            f"catalog format_version {major}.{minor} is newer than {current}: it may name objects this "
            "code cannot enumerate, so update genomeos before publishing or checking it"
        )
    return major, minor
