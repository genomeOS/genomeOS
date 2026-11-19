"""An artifact's fit input at the web publication boundary (#45; data store design 2026-10-17 §5).

Every new artifact carries ``observations.parquet``, the exact table its fit consumed, pinned by
sha256 in its manifest. The Atlas exporter still builds its observations JSON from rows it reloads
through the source adapters, because only they join each row to its citation and study label. So
when an artifact pins its input, the reloaded rows must be that table, row for row, on every column
the web JSON carries. The same number of rows is not enough: the site would show a surface beside
rows it was not fitted to.

The bucket also serves a copy of the manifest. The input record's ``path`` is relative to the
artifact's directory in the data store, which the bucket does not hold, so the copy drops it and
keeps the input's identity: its sha256, size, row count, measurement, columns and contract.

Pure: frames and mappings in, a refusal or a copy out. No I/O.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

import pandas as pd

#: The manifest key that records the input (``genomeos.surfaces.artifacts.ArtifactManifest``).
RECORD_KEY = "observations"
#: Record fields that only mean something inside the data store.
STORE_ONLY_FIELDS = frozenset({"path"})


def require_consumed_rows(
    consumed: pd.DataFrame, reloaded: pd.DataFrame, *, columns: Collection[str], context: str
) -> None:
    """Refuse reloaded rows that are not, row for row, the table the fit consumed.

    Both frames are in the fit's ``ac``/``an`` shape and its row order; ``columns`` are the ones
    the web JSON is built from. Values are compared, not dtypes or the index, so an ``Int64`` count
    read back from parquet equals the same count reloaded as ``int64``.
    """
    if len(consumed) != len(reloaded):
        raise ValueError(
            f"{context}: {len(reloaded)} reloaded observations, but its fit consumed {len(consumed)} (#45)"
        )
    differ = [
        column
        for column in sorted(columns)
        if column not in consumed.columns
        or column not in reloaded.columns
        or not consumed[column].reset_index(drop=True).astype(object).equals(
            reloaded[column].reset_index(drop=True).astype(object)
        )
    ]
    if differ:
        raise ValueError(
            f"{context}: the reloaded observations differ in {differ} from the table its fit consumed; "
            "export from the data the artifact was fitted to (#45)"
        )


def web_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """The manifest as the bucket serves it: a copy whose input record, if any, drops ``path``."""
    served = dict(manifest)
    record = served.get(RECORD_KEY)
    if record is not None:
        served[RECORD_KEY] = {key: value for key, value in record.items() if key not in STORE_ONLY_FIELDS}
    return served
