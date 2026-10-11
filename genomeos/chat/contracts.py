"""Bounded assistant proposals and receipts; Atlas design §§11, 13, 16.

Proposals select existing published views. They cannot express database operations,
new scientific quantities, arbitrary coordinates, URLs, code, or generated prose.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class ChatRequest(Contract):
    message: str = Field(min_length=1, max_length=2000)
    catalog_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    state_token: str = Field(min_length=1, max_length=8000)
    current_id: str = Field(min_length=1, max_length=100)
    current_version: str = Field(min_length=1, max_length=200)
    # Plain user text only: clients cannot supply privileged model roles.
    previous_questions: list[str] = Field(default_factory=list, max_length=4)


class Proposal(Contract):
    operation: Literal["discover", "explain", "view", "compare", "refuse"]
    artifact_ids: list[str] = Field(max_length=2)
    topic: Literal["measurement", "uncertainty", "provenance", "limitations"]
    metric: Literal["post_mean", "post_sd"]
    layers: list[Literal["surface", "observations", "support", "context", "countries"]] = Field(max_length=5)
    region: Literal["current", "world", "west-africa"]


class Selection(Contract):
    id: str
    version: str


class MapAction(Contract):
    id: str
    catalog_revision: str
    state_token: str
    operation: Literal["view", "compare"]
    selections: list[Selection]
    metric: Literal["post_mean", "post_sd"]
    layers: list[str]
    region: Literal["current", "world", "west-africa"]


class Source(Contract):
    label: str
    url: str


class ChatResponse(Contract):
    catalog_revision: str
    answer: str
    sources: list[Source]
    action: MapAction | None
