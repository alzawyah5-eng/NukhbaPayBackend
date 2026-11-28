# Model lifecycle

Reserve this boundary for evaluation, experiment tracking and reviewed promotion
of advisory models.

- **Inputs** — versioned datasets, predictions and actual outcomes, feature
  definitions and the deterministic baseline.
- **Outputs** — results such as success calibration and anomaly false alarm
  rates, plus versioned model, feature, prompt and schema references.
- **Dependencies** — existing [evaluation fixtures](../../../datasets/evaluation)
  and [Python tests](../../../tests). MLflow is a candidate for experiment and
  model tracking once training and deployment are approved. Time-ordered
  evaluation and shadow comparisons belong here.
