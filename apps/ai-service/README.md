# Advisory AI service

Status: **architecture starter with runnable deterministic matching guards**.
The semantic model gateway and FastAPI HTTP service are planned integration
points. No language model is called, and no price, quote, order, or ledger write
is performed by this package.

Planned advisory modules cover [success prediction](src/nukhbapay_ai/success_prediction/README.md),
[selection recommendations](src/nukhbapay_ai/selection_advice/README.md) and
[model lifecycle](src/nukhbapay_ai/model_lifecycle/README.md). The existing
stdio worker and offline matching tests remain the integration reference.

## Responsibilities

1. Receive sanitized, authenticated catalog jobs from the application worker.
2. Propose candidate product matches with source references.
3. Check those candidates against exact product-equivalence constraints.
4. Return advisory results for a separate approval/application workflow.
5. Later, prioritize anomalies and provide explanations using verified numbers.

The included guard covers **gift cards and prepaid airtime**. Bill payments,
remittances, data bundles, and tickets require their own category-specific
contracts and are not accepted by this guard. Identity fields must already use
approved normalized identifiers; this package does not infer brand identities
or currency equivalence from free text.

## Contents

| Path | Responsibility |
| --- | --- |
| `src/nukhbapay_ai/schemas/catalog.py` | Strict job input and advisory output types. |
| `src/nukhbapay_ai/matching/guard.py` | Exact equivalence checks that cannot be overridden by model output. |
| `src/nukhbapay_ai/gateways/model_gateway.py` | Protocol for a future managed or self-hosted model integration. |
| `src/nukhbapay_ai/api/README.md` | Planned internal FastAPI boundary. |
| `src/nukhbapay_ai/anomalies/README.md` | Planned anomaly work and input constraints. |
| `prompts/product-match.md` | Versioned draft instructions for future semantic matching. |
| `datasets/evaluation/matching-cases.json` | Synthetic positive and difficult negative cases. |
| `tests/test_matching.py` | Offline behavior checks. |

## Run the existing checks

From the repository root, with Python 3.11 or newer:

```bash
python3 -m unittest discover -s apps/ai-service/tests -v
```

The checks use the standard library. No package installation, network access,
API key, database, or model is required. `CANDIDATE` means all included hard
constraints agree; it **does not authorize a mapping or publication**. Missing
attributes produce `REQUIRES_REVIEW`. Incompatible attributes produce
`REJECTED`. Every result has `can_publish: false` and explicitly identifies
`deterministic_rules` as its source.

## Runtime boundary to implement next

The worker supplies immutable input references and an authenticated tenant
context. The future HTTP adapter must verify service identity and job
authorization; accepting a tenant ID in JSON does not establish authorization.
Results go through the internal contract to the application review workflow.

The AI runtime receives no provider execution credentials, payment credentials,
or database role that can modify financial records. Do not include card data,
beneficiary identity, customer bills, or gift-card redemption secrets in model
inputs. Catalog descriptions are untrusted data, including instructions hidden
inside them. Schema validation and deterministic equivalence rules remain
mandatory for every proposed match.

Record model, prompt, and schema versions when a model is connected. The current
results use `model_version: null`; the draft prompt has not been executed.
Tune any future automatic acceptance threshold against reviewed production-like
evaluation data, with special attention to false matches.
