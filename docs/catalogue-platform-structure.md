# AI NukhbaPay catalogue structure

This map shows where the catalogue pipeline lives in the active `backend/`
workspace. It builds on the Node.js, TypeScript and pnpm packages and the
existing Python advisory service. It covers the path from provider discovery
to the approved catalogue served to the payment app and kiosks.

## Directory tree

```text
backend/
├── apps/
│   ├── api/src/modules/
│   │   ├── catalog/                Scoped payment and kiosk catalogue reads
│   │   ├── identity/               HTTP authentication and authorization
│   │   ├── pricing-admin/          Staff pricing policy boundary
│   │   └── quotes/                 Planned checkout quote and revalidation
│   ├── admin-web/                  Staff HTTPS portal, catalogue and review UI
│   ├── worker/src/jobs/
│   │   ├── catalogue-refresh-host.ts   Existing durable claim and retry host
│   │   ├── catalog-sync/               Provider refresh entry point
│   │   ├── price-publication/         Publication job boundary
│   │   ├── outbox-relay/               Delivery job boundary
│   │   └── product-intelligence/      Existing Python bridge, new README
│   └── ai-service/
│       ├── src/nukhbapay_ai/
│       │   ├── schemas/, matching/     Advisory job and equivalence checks
│       │   ├── gateways/, jobs/        Model protocol and stdio worker
│       │   ├── api/, anomalies/        Planned FastAPI and anomaly work
│       │   ├── success_prediction/    New prediction boundary
│       │   ├── selection_advice/      New recommendation boundary
│       │   └── model_lifecycle/       New evaluation and model tracking boundary
│       ├── datasets/evaluation/       Existing matching fixtures
│       └── tests/                     Python advisory behavior tests
├── packages/
│   ├── provider-contracts/src/     Normalized backend-only provider types
│   ├── provider-adapters/src/      Isolated provider connectors and HTTP helpers
│   ├── application/src/
│   │   ├── catalog/
│   │   │   ├── synthetic-provider-import.ts      Existing import ports
│   │   │   ├── commercial-price-observation.ts   Disabled AED/USD evidence pilot
│   │   │   ├── publication-candidate.ts          Existing versioned draft builder
│   │   │   ├── publication-workflow.ts           Existing synthetic commands
│   │   │   ├── published-catalogue.ts            Existing scoped read service
│   │   │   ├── matching/                        New canonical matching boundary
│   │   │   └── publication/                     New product bucket boundary
│   │   ├── fx/                    AED normalization service and FX contracts
│   │   ├── pricing/               Rule resolution and calculation breakdowns
│   │   ├── provider-selection/    New eligibility and ranking boundary
│   │   ├── quotes/                Checkout quote and fallback policy
│   │   └── identity/              Existing tenant, permission and audit services
│   ├── domain/src/                 Pure exact money and pricing functions
│   ├── contracts/
│   │   ├── public/                 Customer catalogue and quote payloads
│   │   ├── admin/                  Restricted financial projections
│   │   └── internal/               Worker and advisory envelopes
│   └── database/
│       ├── src/repositories/       Catalogue and IAM repositories
│       ├── src/                   Publication, refresh and job stores
│       ├── migrations/            Registered platform migration history
│       ├── pending-migrations/    SQL proposals for review
│       └── local-catalogue/        Dedicated local catalogue migration track
├── config/
│   ├── catalogue-policies.example.json  New unset policy template
│   └── README.md                        Policy options and ownership
├── infra/
│   ├── local/, deployment/        Existing infrastructure boundaries
│   └── observability/            New metrics and dashboard boundary
├── docs/
│   ├── catalogue-platform-structure.md   This map
│   └── adr/, runbooks/, security/        Decisions and operational controls
├── tests/                        Cross-module integration, contract and security
└── .env.example                   Existing runtime configuration template
```

The new module folders contain READMEs defining responsibilities, inputs,
outputs and dependencies. Existing code stays in its current locations,
including package tests and the separate frontend workspace.

## Pipeline ownership

| Stage | Inputs, outputs and dependencies |
| --- | --- |
| Provider ingestion | The TypeScript [provider adapters](../packages/provider-adapters/README.md) read provider-specific catalogues and commercial evidence. Validated observations retain source IDs, time, product terms, and snapshot completeness. Ingestion uses [shared provider contracts](../packages/provider-contracts/README.md) and tenant-scoped repositories. |
| Matching | [Canonical matching](../packages/application/src/catalog/matching/README.md) compares type, destination, denomination, face currency and delivery restrictions. Approved mapping evidence binds each eligible provider offer to the product it can fulfil. |
| Layer 1 | [AED normalization](../packages/application/src/fx/README.md) resolves approved rate evidence and produces an exact acquisition cost in AED with the original cost and conversion lineage. Face value and face currency travel independently. |
| Layer 2 | [Pricing](../packages/application/src/pricing/README.md) applies versioned rules and rounding to calculate a selling price and contribution breakdown. The current TypeScript domain uses bigint minor units and decimal strings. Python components can use `Decimal` where exact arithmetic is necessary. |
| Layer 3 | [Selection](../packages/application/src/provider-selection/README.md) validates eligibility, then ranks by policy-defined expected net contribution and records the reason and input versions. The current AED sample ranks by effective acquisition cost. |
| Publication | [Product buckets](../packages/application/src/catalog/publication/README.md) combine a validated candidate, validity and approval with versioned internal evidence. PostgreSQL stores the publication history and delivery outbox. The quote boundary owns checkout revalidation and fallback. |
| Distribution | The existing NestJS [catalogue boundary](../apps/api/src/modules/catalog/README.md) binds payment and kiosk credentials to server-owned tenant and kiosk scope. The synthetic composition exposes an indicative display price through [public contracts](../packages/contracts/README.md). The intended production projection carries approved selling prices. |

The TypeScript [worker](../apps/worker/README.md) calls application use cases
through existing claim, retry and outbox ports. PostgreSQL is authoritative
for snapshots, versions and audit. The [application identity boundary](../packages/application/src/identity/README.md)
supplies tenant context and authorization. Provider secret references are
resolved within server-side composition, and staff economics are available
only through restricted interfaces.

The Python [AI service](../apps/ai-service/README.md) receives sanitized jobs
through the worker. It can later provide success predictions, anomaly flags and
selection recommendations for review. Model evaluation compares predictions
with actual outcomes in advisory or shadow mode. The platform owns deterministic
pricing, eligibility and publication.

## Reuse and verification

- Provider, catalogue, monetary, IAM and publication code stay in their
  existing packages. Examples include the Finxplor, SSL Wireless, IronGate,
  and iPay adapters, the synthetic snapshot importer, the paused AED/USD evidence
  pilot, the draft and publication stores, and the payment/kiosk read boundary.
- The [policy example](../config/catalogue-policies.example.json) is a
  configuration scaffold for review. The new READMEs mark the matching, FX,
  selection, publication, AI, worker, identity and observability boundaries.
- Provider fixtures belong in `packages/provider-adapters/test/`. Pure rules
  belong in `packages/domain/test/`, with use case tests in
  `packages/application/test/`. Storage and scoped reads have existing suites
  in `packages/database/test/` and `apps/api/test/`. Python advisory evaluation
  uses `apps/ai-service/tests/` and `datasets/evaluation/` within that service.
- Live FX sourcing, expected-contribution ranking, production publication
  authority, checkout fallback, training and deployment are implementation
  items for later review.

## Open decisions

1. Choose the optimization objective per product, across expected volume, or
   with an explicit reliability weighting. Define the evaluation window,
   costs and reliability inputs before approving a policy.
2. Choose whether selection happens at publication, at checkout, or through a
   published default with controlled fallback. Set price guarantees and
   permitted fallback conditions together.
3. Choose daily, shorter interval, provider event, or hybrid refresh. Set
   drift and staleness limits when approving the schedule.
4. Confirm supported currency scales, approved FX sources, rule precedence
   and rounding, and how provider and agent commissions are recognized.

These choices are described in [catalogue configuration](../config/README.md).
If Python eventually needs independent transport or queues, FastAPI, HTTPX and
Celery with Redis are options. The existing backend adapter boundary remains
the home for provider connections, including SOAP. OR-Tools is an option for
constrained allocation and the [AI module map](../apps/ai-service/README.md)
records model candidates. [Observability](../infra/observability/README.md)
reserves a place for Prometheus and Grafana configuration when needed.
