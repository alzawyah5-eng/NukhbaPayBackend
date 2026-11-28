# Observability

This boundary is for future operational telemetry configuration. Services own
their instrumentation and expose bounded metrics through their existing
runtime boundaries.

- **Inputs** — API health, provider read latency and failures, refresh age
  and outcomes, publication delivery lag, and advisory evaluation results.
- **Outputs** — operational dashboards and alerts for stale catalogues,
  repeated refresh failures, delivery backlogs and model quality changes.
- **Dependencies** — existing [local infrastructure](../local/README.md) and
  [deployment boundary](../deployment/README.md). Prometheus and Grafana are
  proposed for collection and dashboards after metrics, access and retention
  are agreed.

Use low-cardinality metric labels. Restricted correlation and audit references
belong in authorized logs. Keep credentials, customer data and commercial
amounts out of metric labels and general logs.
