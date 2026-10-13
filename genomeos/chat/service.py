"""Deterministic grounded answers and validated display requests; design §§4, 11, 16.

Claim: natural language can select and explain admitted maps without new science.
Acceptance: exact versions, mandatory masks, unchanged state on refusal, cited records.
Public interface: respond(request, proposal, catalog). Browser consumes proposed actions
and must acknowledge renderer success separately. Missing evidence is a refusal.
"""

from __future__ import annotations

from uuid import uuid4

from genomeos.chat.catalog import PublishedCatalog
from genomeos.chat.contracts import ChatRequest, ChatResponse, MapAction, Proposal, Selection, Source

REFUSAL = (
    "I can help discover, display, compare and explain published genomeOS maps. "
    "I cannot modify data, add datasets, run analyses, infer individual risk, or answer unrelated requests. "
    "Numerical trait correlation, pleiotropy, burden and environmental overlays are unavailable."
)
UNCERTAINTY = (
    "Observations are measured; surfaces are inferred. Posterior standard deviation describes model "
    "uncertainty. Unknown and prior-dominated cells provide no supported estimate and must be excluded "
    "from scientific aggregates. A similar-looking map does not establish correlation or pleiotropy."
)


def respond(request: ChatRequest, proposal: Proposal, catalog: PublishedCatalog) -> ChatResponse:
    if request.catalog_revision != catalog.revision:
        raise ValueError("The catalog changed. Reload before requesting an action.")
    current = catalog.entry(request.current_id, request.current_version)
    if proposal.operation == "refuse":
        return ChatResponse(catalog_revision=catalog.revision, answer=REFUSAL, sources=[], action=None)
    if proposal.operation == "discover":
        if proposal.artifact_ids:
            raise ValueError("Discovery cannot select artifacts")
        answer = "Published maps: " + "; ".join(entry["label"] for entry in catalog.entries.values())
        return ChatResponse(
            catalog_revision=catalog.revision,
            answer=answer,
            sources=[Source(label="Published catalog", url="https://genome-os.org/data/atlas/catalog.json")],
            action=None,
        )
    identifiers = proposal.artifact_ids
    if proposal.operation == "explain" and not identifiers:
        identifiers = [current["id"]]
    expected_count = 2 if proposal.operation == "compare" else 1
    if len(identifiers) != expected_count or len(set(identifiers)) != expected_count:
        raise ValueError("An exact independent selection is required for each map")
    entries = [catalog.entry(identifier) for identifier in identifiers]
    sources: list[Source] = []
    paragraphs: list[str] = []
    for entry in entries:
        discovery = entry["discovery"]
        text = f"{entry['label']} ({catalog.version(entry)}): {discovery['map_measures']}"
        if proposal.topic == "measurement":
            text += " " + discovery["relevance"]
        elif proposal.topic == "uncertainty":
            text += " " + UNCERTAINTY
        elif proposal.topic == "provenance":
            text += f" Registry: {entry['registry_version']}. " + " ".join(entry["assumptions"])
            declarations = [resource["commercial_use"] for resource in entry["external_resources"]]
            for declaration in declarations:
                text += (
                    f" Commercial-use finding: {declaration['finding']}; restricted fields: "
                    + ", ".join(declaration["restricted_fields"])
                    + "."
                )
                sources.append(Source(label="Recorded source terms", url=declaration["terms_url"]))
        else:
            text += " " + UNCERTAINTY + " " + " ".join(entry["assumptions"])
        paragraphs.append(text)
        sources.extend(Source(**reference) for reference in discovery["references"])
        sources.append(
            Source(
                label="Versioned map",
                url=(f"https://genome-os.org/app/?entity={entry['id']}&version={catalog.version(entry)}"),
            )
        )
    action = None
    if proposal.operation in {"view", "compare"}:
        layers = list(dict.fromkeys([*proposal.layers, "support"]))
        if "observations" in layers and any(not entry["observations_available"] for entry in entries):
            raise ValueError("Measured observations are unavailable for this artifact")
        action = MapAction(
            id=str(uuid4()),
            catalog_revision=catalog.revision,
            state_token=request.state_token,
            operation=proposal.operation,
            selections=[Selection(id=entry["id"], version=catalog.version(entry)) for entry in entries],
            metric=proposal.metric,
            layers=layers,
            region=proposal.region,
        )
        paragraphs.append("Map action proposed. Application has not yet been confirmed by the viewer.")
    return ChatResponse(
        catalog_revision=catalog.revision, answer="\n\n".join(paragraphs), sources=sources, action=action
    )
