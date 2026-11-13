# Planned anomaly processing

Begin with explicit, versioned checks in the financial/application layer:
missing currency, stale observations, missing costs, large cost movements,
incomplete provider snapshots, and contribution below a policy floor.

Later statistical or model-based analysis can prioritize those exceptions using
sanitized observations. Its output is a review signal with evidence, not a new
price. Keep source timestamps, provider snapshot references, policy versions,
and model/rule versions. Measure false alarms and missed issues on reviewed
history before enabling additional automation.

No anomaly model, financial formula, or publication operation is implemented in
this directory yet.
