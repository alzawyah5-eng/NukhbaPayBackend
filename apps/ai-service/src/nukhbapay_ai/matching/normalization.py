"""Conservative syntax normalization, without inferring financial identity."""

from dataclasses import asdict
from typing import Any, Mapping

from nukhbapay_ai.schemas.catalog import MatchJob, ProductAttributes


def product_mapping(product: ProductAttributes) -> dict[str, Any]:
    payload = asdict(product)
    if payload["restriction_codes"] is not None:
        payload["restriction_codes"] = list(payload["restriction_codes"])
    return payload


def normalize_product(value: Mapping[str, Any]) -> ProductAttributes:
    if not isinstance(value, Mapping):
        raise ValueError("Product attributes must be an object")
    payload = dict(value)
    # Only standard enumerations have safe case/whitespace normalization.
    # Issuer IDs, amounts, record IDs and unknown/missing fields are never inferred.
    for field in ("country", "currency", "redemption_region", "validity", "fulfillment_method"):
        if isinstance(payload.get(field), str):
            payload[field] = payload[field].strip().upper()
    if isinstance(payload.get("category"), str):
        payload["category"] = payload["category"].strip().lower()
    return ProductAttributes.from_mapping(payload)


def normalize_job(value: Mapping[str, Any]) -> MatchJob:
    if not isinstance(value, Mapping):
        raise ValueError("Match job must be an object")
    payload = dict(value)
    for field in ("provider_record", "candidate_record"):
        payload[field] = product_mapping(normalize_product(payload.get(field)))
    return MatchJob.from_mapping(payload)
