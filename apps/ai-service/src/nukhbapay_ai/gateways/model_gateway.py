"""Future semantic-matching interface. No implementation or model call exists."""

from typing import Any, Mapping, Protocol


class ModelGateway(Protocol):
    async def propose_candidates(
        self, sanitized_job: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        """Return schema-bound proposals with model/prompt version provenance.

        The caller must validate outputs and apply hard constraints. This
        interface must never grant publication or financial execution tools.
        """
        ...
