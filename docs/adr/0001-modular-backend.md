# ADR 0001: Modular backend with separate runtimes

Status: accepted for the starter.

Use one repository, a modular TypeScript backend, separate API/worker processes, and an independently isolated Python advisory service. Put reusable use cases in packages/application; pure rules in packages/domain.

Reason: preserve a coherent financial domain while allowing API, import and AI workloads to deploy and scale separately. Ten thousand products alone does not require splitting each feature into a network service.

Consequence: internal package ownership and database access discipline must be enforced. A single repository does not imply universal runtime credentials or cross-module writes.

