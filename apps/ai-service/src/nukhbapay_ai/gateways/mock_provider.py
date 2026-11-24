"""Offline, scripted providers. No SDK, API key, network or execution tools."""

import asyncio
from dataclasses import dataclass
import json
from typing import Any, Mapping


PROVIDER_ORDER = ("openai", "anthropic", "gemini")


@dataclass(frozen=True)
class MockReply:
    payload: str | None = None
    delay_ms: int = 0
    fail: bool = False


class MockModelGateway:
    def __init__(self, provider: str, replies: tuple[MockReply, ...] = ()):
        if provider not in PROVIDER_ORDER or not isinstance(replies, tuple):
            raise ValueError("Invalid mock provider configuration")
        for reply in replies:
            if (type(reply) is not MockReply or type(reply.delay_ms) is not int
                    or not 0 <= reply.delay_ms <= 60_000 or type(reply.fail) is not bool
                    or (reply.payload is not None and not isinstance(reply.payload, str))):
                raise ValueError("Invalid mock response")
        self.provider = provider
        self.model_version = f"mock-{provider}-v1"
        self.calls = 0
        self.cancelled = 0
        self._replies = replies

    async def propose_candidates(self, sanitized_job: Mapping[str, Any]) -> str:
        index = self.calls
        self.calls += 1
        reply = self._replies[min(index, len(self._replies) - 1)] if self._replies else MockReply()
        try:
            await asyncio.sleep(reply.delay_ms / 1000)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        if reply.fail:
            raise RuntimeError("Synthetic provider failure")
        if reply.payload is not None:
            return reply.payload
        return json.dumps({
            "schema_version": "hybrid-proposal-v1",
            "candidate_record_id": sanitized_job["candidate_record"]["record_id"],
            "normalized_product": sanitized_job["provider_record"],
            "duplicate": True,
            "confidence_bps": 9800,
            "manual_review": False,
        })
