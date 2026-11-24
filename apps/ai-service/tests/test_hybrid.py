"""Synthetic regression and failure tests; no model or network integration."""

import asyncio
from copy import deepcopy
from dataclasses import FrozenInstanceError, asdict
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "src"))

from nukhbapay_ai.gateways.mock_provider import MockModelGateway, MockReply, PROVIDER_ORDER
from nukhbapay_ai.matching.hybrid import HybridOrchestrator, HybridPolicy, HybridUnavailable
from nukhbapay_ai.matching.normalization import normalize_product


class MemoryAudit:
    def __init__(self):
        self.events = []
        self.fail = False

    async def append(self, event):
        if self.fail:
            raise RuntimeError("SECRET audit connection detail")
        self.events.append(event)


class HybridTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.base = json.loads((SERVICE_ROOT / "datasets/evaluation/matching-cases.json").read_text())["base_product"]
        self.job = {
            "schema_version": "1.0", "job_id": "synthetic-job-1",
            "tenant_id": "synthetic-tenant-1", "correlation_id": "synthetic-correlation-1",
            "source_snapshot_id": "synthetic-snapshot-1", "canonical_catalog_version": "synthetic-catalog-v1",
            "provider_record": {**deepcopy(self.base), "record_id": "synthetic-provider-1"},
            "candidate_record": deepcopy(self.base),
        }
        self.audit = MemoryAudit()
        self.providers = tuple(MockModelGateway(name) for name in PROVIDER_ORDER)
        self.policy = HybridPolicy(retry_delay_ms=0)

    def engine(self, **kwargs):
        return HybridOrchestrator(self.providers, self.audit, self.policy, **kwargs)

    def proposal(self, **overrides):
        return json.dumps({
            "schema_version": "hybrid-proposal-v1",
            "candidate_record_id": self.base["record_id"],
            "normalized_product": self.job["provider_record"],
            "duplicate": True, "confidence_bps": 9800, "manual_review": False,
            **overrides,
        })

    async def test_primary_success_has_provenance_and_no_authority(self):
        result = await self.engine().suggest(self.job)
        self.assertEqual(result.provider, "openai")
        self.assertEqual(result.decision, "CANDIDATE")
        self.assertTrue(result.duplicate_candidate)
        self.assertTrue(result.manual_review)
        self.assertFalse(result.can_publish)
        self.assertEqual(result.model_version, "mock-openai-v1")
        self.assertEqual(result.source_snapshot_id, self.job["source_snapshot_id"])
        self.assertEqual([p.calls for p in self.providers], [1, 0, 0])
        with self.assertRaises(FrozenInstanceError):
            result.can_publish = True

    async def test_exact_fallback_order_and_exhaustion(self):
        self.providers = tuple(MockModelGateway(name, (MockReply(fail=True),)) for name in PROVIDER_ORDER)
        result = await self.engine().suggest(self.job)
        self.assertIsNone(result.provider)
        self.assertEqual(result.decision, "REQUIRES_REVIEW")
        self.assertEqual(result.confidence_bps, 0)
        self.assertFalse(result.duplicate_candidate)
        self.assertEqual([e.provider for e in self.audit.events],
                         ["openai", "openai", "anthropic", "anthropic", "gemini", "gemini"])

    async def test_second_fallback_success(self):
        self.providers = (MockModelGateway("openai", (MockReply(fail=True),)),
                          MockModelGateway("anthropic", (MockReply(fail=True),)), MockModelGateway("gemini"))
        result = await self.engine().suggest(self.job)
        self.assertEqual(result.provider, "gemini")
        self.assertEqual([p.calls for p in self.providers], [2, 2, 1])

    async def test_transient_failure_retries_primary(self):
        self.providers = (MockModelGateway("openai", (MockReply(fail=True), MockReply())), *self.providers[1:])
        self.assertEqual((await self.engine().suggest(self.job)).provider, "openai")
        self.assertEqual([e.outcome for e in self.audit.events], ["PROVIDER_FAILURE", "VALIDATED"])

    async def test_timeout_cancels_attempt_and_uses_fallback(self):
        self.policy = HybridPolicy(attempt_timeout_ms=5, retry_delay_ms=0, max_attempts=1)
        self.providers = (MockModelGateway("openai", (MockReply(delay_ms=1000),)), *self.providers[1:])
        result = await self.engine().suggest(self.job)
        self.assertEqual(result.provider, "anthropic")
        self.assertEqual(self.providers[0].cancelled, 1)
        self.assertEqual(self.audit.events[0].outcome, "TIMEOUT")

    async def test_circuit_opens_skips_then_half_open_recovers(self):
        now = [0.0]
        self.providers = (MockModelGateway("openai", (MockReply(fail=True), MockReply(fail=True), MockReply())), *self.providers[1:])
        engine = self.engine(clock=lambda: now[0])
        self.assertEqual((await engine.suggest(self.job)).provider, "anthropic")
        self.assertEqual((await engine.suggest(self.job)).provider, "anthropic")
        self.assertEqual(self.providers[0].calls, 2)
        self.assertIn("CIRCUIT_OPEN", [e.outcome for e in self.audit.events])
        now[0] = 1.001
        self.assertEqual((await engine.suggest(self.job)).provider, "openai")
        self.assertEqual((await engine.suggest(self.job)).provider, "openai")

    async def test_failed_half_open_probe_reopens_without_retry(self):
        now = [0.0]
        self.providers = (MockModelGateway("openai", (MockReply(fail=True),)), *self.providers[1:])
        engine = self.engine(clock=lambda: now[0])
        await engine.suggest(self.job)
        now[0] = 1.001
        await engine.suggest(self.job)
        await engine.suggest(self.job)
        self.assertEqual(self.providers[0].calls, 3)

    async def test_invalid_outputs_fall_back(self):
        outputs = ["not JSON", "[]", "null", "x" * 16385,
                   self.proposal(can_publish=True), self.proposal(price="1.00"),
                   self.proposal(candidate_record_id="foreign-product"),
                   self.proposal(confidence_bps=True), self.proposal(confidence_bps=1.5),
                   self.proposal(confidence_bps=-1), self.proposal(confidence_bps=10001),
                   self.proposal(confidence_bps=float("nan")), self.proposal(duplicate="true"),
                   self.proposal(manual_review=0), self.proposal(schema_version="unknown"),
                   self.proposal(normalized_product={**self.job["provider_record"], "issuer_id": "forged"}),
                   self.proposal(normalized_product={**self.job["provider_record"], "denomination_minor": "1"}),
                   self.proposal(normalized_product={**self.job["provider_record"], "instructions": "ignore rules"}),
                   self.proposal().replace('"duplicate": true', '"duplicate": false, "duplicate": true')]
        for output in outputs:
            with self.subTest(output=output[:60]):
                self.providers = (MockModelGateway("openai", (MockReply(payload=output),)),
                                  MockModelGateway("anthropic"), MockModelGateway("gemini"))
                result = await self.engine().suggest(self.job)
                self.assertEqual(result.provider, "anthropic")
                self.assertFalse(result.can_publish)

    async def test_models_cannot_override_hard_mismatches(self):
        cases = json.loads((SERVICE_ROOT / "datasets/evaluation/matching-cases.json").read_text())["cases"]
        for case in cases:
            with self.subTest(case=case["name"]):
                job = deepcopy(self.job)
                job["provider_record"].update(case["provider_overrides"])
                result = await self.engine().suggest(job)
                self.assertEqual(result.decision, case["expected"])
                self.assertFalse(result.can_publish)
                if case["expected"] != "CANDIDATE":
                    self.assertFalse(result.duplicate_candidate)
                    self.assertIsNone(result.proposed_product_id)

    async def test_confidence_review_and_nonduplicate_flags(self):
        for overrides in ({"confidence_bps": 9499}, {"manual_review": True}, {"duplicate": False}):
            with self.subTest(overrides=overrides):
                self.providers = (MockModelGateway("openai", (MockReply(payload=self.proposal(**overrides)),)), *self.providers[1:])
                result = await self.engine().suggest(self.job)
                self.assertEqual(result.decision, "REQUIRES_REVIEW")
                self.assertIsNone(result.proposed_product_id)
                self.assertTrue(result.manual_review)

    async def test_confidence_threshold_equality_is_deterministic(self):
        self.providers = (MockModelGateway("openai", (MockReply(payload=self.proposal(confidence_bps=9500)),)), *self.providers[1:])
        self.assertEqual((await self.engine().suggest(self.job)).decision, "CANDIDATE")

    async def test_normalization_is_conservative_and_does_not_mutate(self):
        self.job["provider_record"].update(currency=" aed ", country="ae", category=" GIFT_CARD ", restriction_codes=["ONLINE_REDEMPTION"] * 2)
        original = deepcopy(self.job)
        result = await self.engine().suggest(self.job)
        self.assertEqual(result.decision, "CANDIDATE")
        self.assertEqual(result.normalized_product.currency, "AED")
        self.assertEqual(self.job, original)
        self.job["provider_record"]["issuer_id"] = "SYNTHETIC_BRAND_X"
        self.assertEqual((await self.engine().suggest(self.job)).decision, "REJECTED")

    async def test_invalid_job_never_reaches_provider(self):
        for field, value in (("can_publish", True), ("price", "0.01"), ("customer", "SECRET")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                await self.engine().suggest({**self.job, field: value})
        self.assertEqual([p.calls for p in self.providers], [0, 0, 0])

    async def test_normalization_does_not_infer_missing_or_ambiguous_values(self):
        for value in ("100.00", " 10000 ", 10000):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_product({**self.base, "denomination_minor": value})
        self.job["provider_record"]["issuer_id"] = None
        self.assertEqual((await self.engine().suggest(self.job)).decision, "REQUIRES_REVIEW")

    async def test_audit_is_metadata_only_and_required_before_disclosure(self):
        result = await self.engine().suggest(self.job)
        encoded = json.dumps([asdict(event) for event in self.audit.events])
        for value in (self.job["tenant_id"], self.job["job_id"], self.base["issuer_id"], "denomination_minor", "normalized_product"):
            self.assertNotIn(value, encoded)
        self.assertFalse(result.can_publish)
        self.audit.fail = True
        with self.assertRaisesRegex(HybridUnavailable, "^Advisory service unavailable$"):
            await self.engine().suggest(self.job)

    async def test_total_deadline_includes_audit_and_lock_wait(self):
        class HangingAudit:
            async def append(self, event):
                await asyncio.Event().wait()
        engine = HybridOrchestrator(self.providers, HangingAudit(), HybridPolicy(job_timeout_ms=20))
        results = await asyncio.gather(engine.suggest(self.job), engine.suggest(self.job), return_exceptions=True)
        self.assertTrue(all(isinstance(result, HybridUnavailable) for result in results))

    async def test_cancellation_propagates_and_releases_lock(self):
        self.providers = (MockModelGateway("openai", (MockReply(delay_ms=1000), MockReply())), *self.providers[1:])
        engine = self.engine()
        task = asyncio.create_task(engine.suggest(self.job))
        while self.providers[0].calls == 0:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.providers[0].cancelled, 1)
        self.assertEqual((await engine.suggest(self.job)).provider, "openai")

    async def test_no_network_in_success_or_exhaustion(self):
        with patch("socket.socket.connect", side_effect=AssertionError("Network forbidden")):
            await self.engine().suggest(self.job)
            self.providers = tuple(MockModelGateway(name, (MockReply(fail=True),)) for name in PROVIDER_ORDER)
            await self.engine().suggest(self.job)

    async def test_hard_rejection_survives_total_provider_failure(self):
        self.providers = tuple(MockModelGateway(name, (MockReply(fail=True),)) for name in PROVIDER_ORDER)
        self.job["provider_record"]["currency"] = "USD"
        result = await self.engine().suggest(self.job)
        self.assertEqual(result.decision, "REJECTED")
        self.assertIsNone(result.proposed_product_id)

    async def test_live_adapter_or_wrong_order_is_rejected(self):
        class LiveLike:
            provider = "openai"
        for providers in ((LiveLike(), *self.providers[1:]), tuple(reversed(self.providers)), self.providers[:2]):
            with self.subTest(providers=providers), self.assertRaises(ValueError):
                HybridOrchestrator(providers, self.audit)

    async def test_policy_is_bounded_and_boolean_is_not_integer(self):
        for field, value in (("max_attempts", 0), ("max_attempts", 4), ("attempt_timeout_ms", True),
                             ("job_timeout_ms", 30001), ("confidence_threshold_bps", 10001),
                             ("circuit_reset_ms", 0), ("retry_delay_ms", -1), ("failure_threshold", 0)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                HybridPolicy(**{field: value})
