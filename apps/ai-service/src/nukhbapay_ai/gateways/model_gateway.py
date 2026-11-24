"""Advisory proposal interface. Day 1 composition accepts mock adapters only."""

from typing import Any, Mapping, Protocol


class ModelGateway(Protocol):
    async def propose_candidates(
        self, sanitized_job: Mapping[str, Any]
    ) -> str:
        """Return bounded JSON for independent schema validation.

        The caller must validate outputs and apply hard constraints. This
        interface must never grant publication or financial execution tools.
        """
        ...
