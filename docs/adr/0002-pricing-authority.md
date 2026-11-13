# ADR 0002: Deterministic financial authority

Status: accepted for the starter.

Authoritative amounts, provider eligibility, fee rules, publication and quote/order transitions are controlled backend functions with versioned inputs. AI provides schema-validated suggestions and anomaly observations.

Reason: a price must be reproducible and explainable; external text and model responses are untrusted inputs.

Consequence: the initial system needs approved mappings and exception review. Checkout operates independently of model availability. Python advisory logic does not duplicate the authoritative TypeScript financial calculation.

