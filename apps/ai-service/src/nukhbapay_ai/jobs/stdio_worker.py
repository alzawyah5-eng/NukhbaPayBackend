"""One bounded trusted-worker invocation; not an HTTP/authentication service."""

import asyncio
from dataclasses import asdict
import json
import sys

from nukhbapay_ai.gateways.mock_provider import MockModelGateway, MockReply, PROVIDER_ORDER
from nukhbapay_ai.matching.hybrid import HybridOrchestrator


class BufferedAudit:
    def __init__(self):
        self.events = []

    async def append(self, event):
        if len(self.events) >= 9:
            raise ValueError("Audit limit")
        self.events.append(asdict(event))


async def execute(payload, scenario="normal"):
    # Trusted test configuration only, never selected by a submitted job.
    if scenario == "worker_timeout":
        await asyncio.sleep(60)
    if scenario == "worker_crash":
        sys.stderr.write("SYNTHETIC_SECRET_DO_NOT_PERSIST")
        raise SystemExit(73)
    audit = BufferedAudit()
    replies = {"normal": (), "primary_failure": (MockReply(fail=True),),
               "primary_timeout": (MockReply(delay_ms=1000),),
               "invalid_primary_output": (MockReply(payload='{"can_publish":true}'),),
               "all_failure": (MockReply(fail=True),),
               "first_two_failure": (MockReply(fail=True),),
               "worker_timeout": (), "malicious_output": (), "publish_output": ()}
    if scenario not in replies:
        raise ValueError("Invalid mock fixture")
    providers = tuple(MockModelGateway(name, replies[scenario] if index == 0 or scenario == "all_failure" or scenario == "first_two_failure" and index < 2 else ())
                      for index, name in enumerate(PROVIDER_ORDER))
    engine = HybridOrchestrator(providers, audit)
    result = await engine.suggest(payload)
    # Source content stays in this process. Parent commits this allowlist and
    # buffered events atomically before disclosing any advisory result.
    output = {"summary": {
        "provider": result.provider, "modelVersion": result.model_version,
        "promptVersion": result.prompt_version, "rulesVersion": result.rules_version,
        "decision": result.decision, "confidenceBps": result.confidence_bps,
        "duplicateCandidate": result.duplicate_candidate,
        "manualReview": True, "can_publish": False,
    }, "events": audit.events}
    if scenario == "publish_output":
        output["summary"]["can_publish"] = True
    if scenario == "malicious_output":
        output["summary"]["price"] = "SYNTHETIC_SECRET_DO_NOT_PERSIST"
        output["raw_prompt"] = payload
    return output


def main():
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise ValueError("Input limit")
        scenario = "normal"
        if len(sys.argv) == 3 and sys.argv[1] == "--mock-scenario":
            scenario = sys.argv[2]
        elif len(sys.argv) != 1:
            raise ValueError("Invalid invocation")
        result = asyncio.run(execute(json.loads(raw), scenario))
        sys.stdout.write(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except Exception:
        sys.stderr.write("Advisory worker unavailable\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
