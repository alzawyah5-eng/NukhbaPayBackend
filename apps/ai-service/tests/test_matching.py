"""Meaningful offline checks of financial-product equivalence safeguards."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "src"))

from nukhbapay_ai.matching.guard import review_candidate
from nukhbapay_ai.schemas.catalog import MatchJob


class MatchingGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = json.loads((SERVICE_ROOT / "datasets/evaluation/matching-cases.json").read_text())

    def job_data(self, overrides=None):
        candidate = deepcopy(self.fixtures["base_product"])
        provider = deepcopy(candidate)
        provider["record_id"] = "synthetic_provider_a_100"
        provider.update(overrides or {})
        return {
            "schema_version": "1.0", "job_id": "synthetic-job-1",
            "tenant_id": "synthetic-tenant-1", "correlation_id": "synthetic-correlation-1",
            "source_snapshot_id": "synthetic-snapshot-1",
            "canonical_catalog_version": "synthetic-catalog-v1",
            "provider_record": provider, "candidate_record": candidate,
        }

    def test_reviewed_synthetic_cases(self):
        for case in self.fixtures["cases"]:
            with self.subTest(case=case["name"]):
                output = review_candidate(MatchJob.from_mapping(self.job_data(case["provider_overrides"])))
                self.assertEqual(output.decision, case["expected"])
                self.assertIs(output.can_publish, False)

    def test_provenance_and_no_fake_model_claim(self):
        output = review_candidate(MatchJob.from_mapping(self.job_data())).to_dict()
        self.assertEqual(output["source"], "deterministic_rules")
        self.assertEqual(output["schema_version"], "1.0")
        self.assertEqual(output["tenant_id"], "synthetic-tenant-1")
        self.assertEqual(output["source_snapshot_id"], "synthetic-snapshot-1")
        self.assertIsNone(output["model_version"])
        self.assertIsNone(output["prompt_version"])
        self.assertTrue(output["evidence"])
        json.dumps(output)

    def test_a_mismatch_cannot_be_downgraded_by_missing_data(self):
        output = review_candidate(MatchJob.from_mapping(self.job_data({"currency": "USD", "validity": None})))
        self.assertEqual(output.decision, "REJECTED")
        self.assertIsNone(output.proposed_product_id)

    def test_missing_on_both_sides_is_not_a_match(self):
        payload = self.job_data({"validity": None})
        payload["candidate_record"]["validity"] = None
        output = review_candidate(MatchJob.from_mapping(payload))
        self.assertEqual(output.decision, "REQUIRES_REVIEW")

    def test_model_cannot_supply_an_authorization_field(self):
        payload = self.job_data()
        payload["can_publish"] = True
        with self.assertRaises(ValueError):
            MatchJob.from_mapping(payload)

    def test_unsupported_product_type_requires_separate_contract(self):
        with self.assertRaises(ValueError):
            MatchJob.from_mapping(self.job_data({"category": "remittance"}))

    def test_ambiguous_amount_representation_is_rejected(self):
        for amount in [10000, "100.00", "-100", "NaN", "010000", "0"]:
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                MatchJob.from_mapping(self.job_data({"denomination_minor": amount}))

    def test_known_empty_restrictions_are_different_from_unknown(self):
        payload = self.job_data({"restriction_codes": []})
        payload["candidate_record"]["restriction_codes"] = []
        self.assertEqual(review_candidate(MatchJob.from_mapping(payload)).decision, "CANDIDATE")

    def test_input_records_remain_unchanged(self):
        payload = self.job_data()
        original = deepcopy(payload)
        review_candidate(MatchJob.from_mapping(payload))
        self.assertEqual(payload, original)


if __name__ == "__main__":
    unittest.main()
