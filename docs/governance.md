# Nukhbapay — Local Development and Management Approval Policy

We are continuing Nukhbapay development locally.

Management has not yet approved production infrastructure, identity-data residency, real staff onboarding, live supplier integrations, or financial operations.

## Development policy

1. Continue approved local development using synthetic data, test identities, and local test infrastructure.
2. Do not block safe local development solely because production decisions remain pending.
3. Maintain `docs/governance/pending-management-approvals.md`.
4. Record every decision requiring management approval, including the reason, required stage, recommended options, and current status.
5. Mark all unapproved decisions as PENDING. Never assume approval.
6. Update the approval register whenever a new management dependency is discovered.
7. Before creating external accounts, sending real data externally, connecting live providers, or deploying online, identify all applicable approval gates and stop for authorization.
8. Never enable live financial operations without the required security, operational, and regulatory approvals.
9. Keep authentication provider-independent until external provider setup is approved.
10. Preserve existing database permissions, security controls, migrations, and completed tests.

## Current task

Document these governance rules and prepare the management approval register.

Continue with Brick 3B-1 only if that bounded coding task has already been explicitly authorized.

Do not create external resources, apply migration 004 to `nukhabapay_dev`, or begin another brick without approval.

At each completed brick, include a short section titled "Pending Management Approvals" in the progress report.