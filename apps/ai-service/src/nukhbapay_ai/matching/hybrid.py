"""Mock-only hybrid advisory orchestration. Never a publication authority."""

import asyncio
from dataclasses import asdict, dataclass
import json
from time import monotonic
from typing import Any, Callable, Mapping, Protocol

from nukhbapay_ai.gateways.mock_provider import MockModelGateway, PROVIDER_ORDER
from nukhbapay_ai.matching.guard import review_candidate
from nukhbapay_ai.matching.normalization import normalize_job, product_mapping
from nukhbapay_ai.schemas.catalog import MatchJob, ProductAttributes


class HybridUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("Advisory service unavailable")


@dataclass(frozen=True)
class HybridPolicy:
    attempt_timeout_ms: int = 250
    job_timeout_ms: int = 3000
    max_attempts: int = 2
    retry_delay_ms: int = 10
    failure_threshold: int = 2
    circuit_reset_ms: int = 1000
    confidence_threshold_bps: int = 9500

    def __post_init__(self):
        bounds = {
            "attempt_timeout_ms": (1, 5000), "job_timeout_ms": (1, 30_000),
            "max_attempts": (1, 3), "retry_delay_ms": (0, 1000),
            "failure_threshold": (1, 10), "circuit_reset_ms": (1, 60_000),
            "confidence_threshold_bps": (0, 10_000),
        }
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ValueError("Invalid hybrid policy")


@dataclass(frozen=True)
class HybridAuditEvent:
    # Closed metadata allowlist: no job/tenant/product IDs, content or exception text.
    schema_version: str
    provider: str
    model_version: str
    prompt_version: str
    attempt: int
    outcome: str


class HybridAuditWriter(Protocol):
    async def append(self, event: HybridAuditEvent) -> None: ...


@dataclass(frozen=True)
class HybridSuggestion:
    schema_version: str
    job_id: str
    tenant_id: str
    correlation_id: str
    source_snapshot_id: str
    canonical_catalog_version: str
    source: str
    provider: str | None
    model_version: str | None
    prompt_version: str
    rules_version: str
    decision: str
    proposed_product_id: str | None
    normalized_product: ProductAttributes
    duplicate_candidate: bool
    confidence_bps: int
    manual_review: bool
    can_publish: bool


@dataclass
class _Circuit:
    failures: int = 0
    open_until: float = 0


def _parse_proposal(raw: str, job: MatchJob) -> tuple[bool, int, bool]:
    if not isinstance(raw, str) or len(raw) > 16_384:
        raise ValueError("Invalid model output")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate output field")
            result[key] = value
        return result

    payload = json.loads(raw, object_pairs_hook=unique)
    fields = {"schema_version", "candidate_record_id", "normalized_product",
              "duplicate", "confidence_bps", "manual_review"}
    if (not isinstance(payload, dict) or set(payload) != fields
            or payload["schema_version"] != "hybrid-proposal-v1"
            or payload["candidate_record_id"] != job.candidate_record.record_id
            or type(payload["duplicate"]) is not bool
            or type(payload["manual_review"]) is not bool
            or type(payload["confidence_bps"]) is not int
            or not 0 <= payload["confidence_bps"] <= 10_000):
        raise ValueError("Invalid model output")
    normalized = ProductAttributes.from_mapping(payload["normalized_product"])
    if normalized != job.provider_record:
        raise ValueError("Model changed source identity")
    return payload["duplicate"], payload["confidence_bps"], payload["manual_review"]


class HybridOrchestrator:
    def __init__(self, providers: tuple[MockModelGateway, ...], audit: HybridAuditWriter,
                 policy: HybridPolicy = HybridPolicy(), *, clock: Callable[[], float] = monotonic):
        # Deliberately reject live/custom adapters in this first milestone.
        if (not isinstance(providers, tuple) or len(providers) != 3
                or any(type(p) is not MockModelGateway for p in providers)
                or tuple(p.provider for p in providers) != PROVIDER_ORDER
                or type(policy) is not HybridPolicy):
            raise ValueError("Exactly three ordered mock providers are required")
        self._providers = providers
        self._audit = audit
        self._policy = policy
        self._clock = clock
        self._circuits = {name: _Circuit() for name in PROVIDER_ORDER}
        # One half-open probe at a time; queued jobs share their total deadline.
        self._lock = asyncio.Lock()

    async def _record(self, provider: MockModelGateway, attempt: int, outcome: str):
        event = HybridAuditEvent("hybrid-audit-v1", provider.provider,
                                 provider.model_version, "product-match-mock-v1", attempt, outcome)
        try:
            await self._audit.append(event)
        except Exception:
            raise HybridUnavailable() from None

    def _result(self, job: MatchJob, decision: str, provider: MockModelGateway | None,
                duplicate: bool = False, confidence: int = 0) -> HybridSuggestion:
        return HybridSuggestion(
            "hybrid-advisory-v1", job.job_id, job.tenant_id, job.correlation_id,
            job.source_snapshot_id, job.canonical_catalog_version, "mock_hybrid",
            provider.provider if provider else None, provider.model_version if provider else None,
            "product-match-mock-v1", "equivalence-v1", decision,
            job.candidate_record.record_id if decision == "CANDIDATE" else None,
            job.provider_record, duplicate, confidence,
            # Confidence is mock metadata, never calibrated approval authority.
            True, False,
        )

    async def suggest(self, payload: Mapping[str, Any]) -> HybridSuggestion:
        job = normalize_job(payload)
        deterministic = review_candidate(job)
        try:
            async with asyncio.timeout(self._policy.job_timeout_ms / 1000):
                async with self._lock:
                    return await self._suggest(job, deterministic.decision)
        except TimeoutError:
            raise HybridUnavailable() from None

    async def _suggest(self, job: MatchJob, hard_decision: str) -> HybridSuggestion:
        for provider in self._providers:
            circuit = self._circuits[provider.provider]
            if circuit.open_until > self._clock():
                await self._record(provider, 0, "CIRCUIT_OPEN")
                continue
            probe = circuit.failures >= self._policy.failure_threshold
            for attempt in range(1, self._policy.max_attempts + 1):
                # Fresh input per attempt, so an adapter cannot mutate the guarded job.
                sanitized = asdict(job)
                for key in ("provider_record", "candidate_record"):
                    sanitized[key] = product_mapping(getattr(job, key))
                try:
                    raw = await asyncio.wait_for(provider.propose_candidates(sanitized),
                                                 self._policy.attempt_timeout_ms / 1000)
                    duplicate, confidence, review = _parse_proposal(raw, job)
                except Exception as error:
                    outcome = ("TIMEOUT" if isinstance(error, TimeoutError) else
                               "INVALID_OUTPUT" if isinstance(error, (ValueError, TypeError, RecursionError))
                               else "PROVIDER_FAILURE")
                    circuit.failures += 1
                    if probe or circuit.failures >= self._policy.failure_threshold:
                        circuit.open_until = self._clock() + self._policy.circuit_reset_ms / 1000
                    await self._record(provider, attempt, outcome)
                    if circuit.open_until > self._clock() or attempt == self._policy.max_attempts:
                        break
                    await asyncio.sleep(self._policy.retry_delay_ms / 1000)
                    continue
                circuit.failures = 0
                circuit.open_until = 0
                await self._record(provider, attempt, "VALIDATED")
                decision = hard_decision
                if decision == "CANDIDATE" and (review or confidence < self._policy.confidence_threshold_bps or not duplicate):
                    decision = "REQUIRES_REVIEW"
                return self._result(job, decision, provider,
                                    duplicate and hard_decision == "CANDIDATE", confidence)
        # Preserve hard rejection when all models fail; never invent a match.
        return self._result(job, "REJECTED" if hard_decision == "REJECTED" else "REQUIRES_REVIEW", None)
