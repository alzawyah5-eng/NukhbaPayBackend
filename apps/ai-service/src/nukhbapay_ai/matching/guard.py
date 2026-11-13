"""Hard constraints for advisory candidates; no semantic model is called."""

from nukhbapay_ai.schemas.catalog import FieldEvidence, MatchJob, MatchSuggestion


COMPARISON_FIELDS = (
    "category", "country", "currency", "issuer_id", "denomination_minor",
    "redemption_region", "validity", "fulfillment_method", "restriction_codes",
)


def review_candidate(job: MatchJob) -> MatchSuggestion:
    # Revalidate even dataclass instances: Python annotations alone do not
    # validate direct construction at a service boundary.
    from dataclasses import asdict
    payload = asdict(job)
    for key in ("provider_record", "candidate_record"):
        if payload[key]["restriction_codes"] is not None:
            payload[key]["restriction_codes"] = list(payload[key]["restriction_codes"])
    job = MatchJob.from_mapping(payload)

    evidence = []
    for name in COMPARISON_FIELDS:
        left = getattr(job.provider_record, name)
        right = getattr(job.candidate_record, name)
        outcome = "MISSING" if left is None or right is None else ("MATCH" if left == right else "MISMATCH")
        evidence.append(FieldEvidence(
            field=name,
            outcome=outcome,
            provider_record_id=job.provider_record.record_id,
            candidate_record_id=job.candidate_record.record_id,
        ))

    outcomes = {item.outcome for item in evidence}
    if "MISMATCH" in outcomes:
        decision = "REJECTED"
    elif "MISSING" in outcomes:
        decision = "REQUIRES_REVIEW"
    else:
        decision = "CANDIDATE"

    return MatchSuggestion(
        schema_version="1.0",
        job_id=job.job_id,
        tenant_id=job.tenant_id,
        correlation_id=job.correlation_id,
        source_snapshot_id=job.source_snapshot_id,
        canonical_catalog_version=job.canonical_catalog_version,
        source="deterministic_rules",
        rules_version="equivalence-v1",
        model_version=None,
        prompt_version=None,
        decision=decision,
        proposed_product_id=job.candidate_record.record_id if decision == "CANDIDATE" else None,
        can_publish=False,
        evidence=tuple(evidence),
    )
