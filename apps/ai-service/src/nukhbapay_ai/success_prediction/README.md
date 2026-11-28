# Provider success prediction

In advisory mode, estimate the likelihood of a successful provider transaction
for a given product and decision time.

- **Inputs** — authorized historical outcome features, such as provider and
  product references, observed success and failure classes, and timing. Use
  features available at the original decision time.
- **Outputs** — a versioned success estimate and evidence reference for
  platform review. Join predictions to actual outcomes during offline
  evaluation.
- **Dependencies** — Python and the existing internal job boundary. XGBoost
  and LightGBM are candidates after labeled history and an evaluation plan
  are available.
