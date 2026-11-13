# Runbook design: unknown provider outcome

Status: operational design, not a live runbook for any selected provider.

1. Preserve the order, payment state, provider attempt/reference and last response.
2. Stop automatic rerouting or new financial submission for the unresolved operation.
3. Use the provider's documented status lookup and verified callbacks.
4. Compare internal ledger/payment/provider records and escalate within defined service limits.
5. Apply confirmed transitions or authorized adjustments with full audit evidence.
6. Communicate a pending status; never label uncertain delivery as definitive failure.
7. Reconcile the final settlement and resolve any associated customer/agent commission impact.

Provider-specific lookup windows, escalation contacts, reversal guarantees and refund handling must be completed when the integration is selected.

