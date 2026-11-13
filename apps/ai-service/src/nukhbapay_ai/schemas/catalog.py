"""Small strict contracts using only Python's standard library.

Amounts identify a product's face value in currency minor units; this module
does not calculate money or assume that every currency has two decimal places.
"""

from dataclasses import asdict, dataclass
import re
from typing import Any, Literal, Mapping


Decision = Literal["CANDIDATE", "REQUIRES_REVIEW", "REJECTED"]


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value):
        raise ValueError(f"{field} must be a bounded nonempty identifier")
    return value


def _optional_text(value: Any, field: str, pattern: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"Invalid {field}")
    return value


@dataclass(frozen=True)
class ProductAttributes:
    record_id: str
    category: Literal["gift_card", "prepaid_airtime"]
    country: str | None
    currency: str | None
    issuer_id: str | None
    denomination_minor: str | None
    redemption_region: str | None
    validity: str | None
    fulfillment_method: str | None
    restriction_codes: tuple[str, ...] | None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ProductAttributes":
        if not isinstance(value, Mapping):
            raise ValueError("Product attributes must be an object")
        allowed = set(cls.__dataclass_fields__)
        if set(value) - allowed:
            raise ValueError("Unknown product attribute")
        if value.get("category") not in ("gift_card", "prepaid_airtime"):
            raise ValueError("Category requires a separate equivalence contract")
        restrictions = value.get("restriction_codes")
        if restrictions is not None:
            if not isinstance(restrictions, list) or len(restrictions) > 100:
                raise ValueError("restriction_codes must be a bounded array or null")
            restrictions = tuple(sorted({_identifier(v, "restriction_code") for v in restrictions}))
        return cls(
            record_id=_identifier(value.get("record_id"), "record_id"),
            category=value["category"],
            country=_optional_text(value.get("country"), "country", r"[A-Z]{2}"),
            currency=_optional_text(value.get("currency"), "currency", r"[A-Z]{3}"),
            issuer_id=(None if value.get("issuer_id") is None else _identifier(value["issuer_id"], "issuer_id")),
            denomination_minor=_optional_text(value.get("denomination_minor"), "denomination_minor", r"[1-9][0-9]{0,17}"),
            redemption_region=_optional_text(value.get("redemption_region"), "redemption_region", r"[A-Z][A-Z0-9_-]{1,31}"),
            validity=_optional_text(value.get("validity"), "validity", r"NO_EXPIRY|P[1-9][0-9]{0,5}D"),
            fulfillment_method=_optional_text(value.get("fulfillment_method"), "fulfillment_method", r"PIN|DIRECT_RECHARGE|DIGITAL_CODE"),
            restriction_codes=restrictions,
        )


@dataclass(frozen=True)
class MatchJob:
    schema_version: str
    job_id: str
    tenant_id: str
    correlation_id: str
    source_snapshot_id: str
    canonical_catalog_version: str
    provider_record: ProductAttributes
    candidate_record: ProductAttributes

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "MatchJob":
        if not isinstance(value, Mapping) or set(value) != set(cls.__dataclass_fields__):
            raise ValueError("Match job must contain exactly the required fields")
        if value["schema_version"] != "1.0":
            raise ValueError("Unsupported schema version")
        return cls(
            schema_version="1.0",
            job_id=_identifier(value["job_id"], "job_id"),
            tenant_id=_identifier(value["tenant_id"], "tenant_id"),
            correlation_id=_identifier(value["correlation_id"], "correlation_id"),
            source_snapshot_id=_identifier(value["source_snapshot_id"], "source_snapshot_id"),
            canonical_catalog_version=_identifier(value["canonical_catalog_version"], "canonical_catalog_version"),
            provider_record=ProductAttributes.from_mapping(value["provider_record"]),
            candidate_record=ProductAttributes.from_mapping(value["candidate_record"]),
        )


@dataclass(frozen=True)
class FieldEvidence:
    field: str
    outcome: Literal["MATCH", "MISMATCH", "MISSING"]
    provider_record_id: str
    candidate_record_id: str


@dataclass(frozen=True)
class MatchSuggestion:
    schema_version: str
    job_id: str
    tenant_id: str
    correlation_id: str
    source_snapshot_id: str
    canonical_catalog_version: str
    source: Literal["deterministic_rules"]
    rules_version: str
    model_version: None
    prompt_version: None
    decision: Decision
    proposed_product_id: str | None
    can_publish: Literal[False]
    evidence: tuple[FieldEvidence, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
