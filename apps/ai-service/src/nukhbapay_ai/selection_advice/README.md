# Selection advice

Compare the platform's recorded provider decision with advisory predictions
and flag potential improvements for review.

- **Inputs** — sanitized decision and eligible offer references, prediction
  versions, anomaly flags, and later transaction outcomes.
- **Outputs** — a recommendation with evidence and the policy version used in
  the comparison. In shadow mode, log the recommendation and compare it with
  actual outcomes.
- **Dependencies** — [success prediction](../success_prediction/README.md),
  [anomaly signals](../anomalies/README.md) and the [internal job contracts](../../../../../packages/contracts/internal/README.md).
  The platform's deterministic eligibility and pricing rules retain authority
  over offer selection.
