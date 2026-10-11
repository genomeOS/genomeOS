"""Read adapter for the published web catalog; Atlas design §§5, 11, 13, 16.

The model receives metadata through this bounded read interface, never file access.
Publication admission is the existing reviewed allowlist, matched to exact immutable
identities. No burden or general-purpose surface endpoint is exposed by this app.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class PublishedCatalog:
    def __init__(self, catalog: dict[str, Any], allowlist: dict[str, Any]) -> None:
        if catalog["schema_version"] != 1 or allowlist["schema_version"] != 1:
            raise ValueError("Unsupported publication catalog")
        if any(catalog[key] != allowlist[key] for key in ("hf_dataset", "hf_revision")):
            raise ValueError("Publication revision mismatch")
        allowed = {item["id"]: item for item in allowlist["artifacts"]}
        self.entries: dict[str, dict[str, Any]] = {}
        for entry in catalog["artifacts"]:
            identity = allowed.get(entry["id"])
            if identity is None or identity["variant_id"] != entry["variant_id"]:
                raise ValueError("Unadmitted artifact")
            variant_key = entry["variant_id"].replace(":", "__")
            expected = f"{variant_key}__{entry['model_version']}__{entry['data_version']}"
            if identity["artifact_dir"] != expected or entry["id"] in self.entries:
                raise ValueError("Ambiguous artifact identity")
            if entry["measurement"] not in {"allele_frequency", "phenotype_frequency", "carrier_frequency"}:
                raise ValueError("Unsupported measurement")
            self.entries[entry["id"]] = entry
        if not self.entries or len(self.entries) > 100:
            raise ValueError("Publication catalog must contain 1–100 maps")
        encoded = json.dumps(catalog, sort_keys=True, separators=(",", ":")).encode()
        self.revision = hashlib.sha256(encoded).hexdigest()

    @classmethod
    def load(cls, catalog_path: Path, allowlist_path: Path) -> PublishedCatalog:
        return cls(json.loads(catalog_path.read_text()), json.loads(allowlist_path.read_text()))

    def entry(self, identifier: str, version: str | None = None) -> dict[str, Any]:
        entry = self.entries.get(identifier)
        if entry is None or (version is not None and version != self.version(entry)):
            raise ValueError("Artifact ID or version is not published")
        return entry

    @staticmethod
    def version(entry: dict[str, Any]) -> str:
        return f"{entry['model_version']}/{entry['data_version']}"

    def metadata(self) -> list[dict[str, Any]]:
        fields = (
            "id",
            "label",
            "variant_id",
            "entity_type",
            "measurement",
            "model_version",
            "data_version",
            "registry_version",
            "hf_dataset",
            "hf_revision",
            "surface_sha256",
            "observations_sha256",
            "observations_available",
            "assumptions",
            "discovery",
        )
        return [{key: entry[key] for key in fields} for entry in self.entries.values()]
