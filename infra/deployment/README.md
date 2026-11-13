# Deployment design

Status: planned. No cloud resources or production configuration are created.

Initial runtime units: API, background workers, and advisory AI workers. CRM and kiosk clients are separate user interfaces. Use managed PostgreSQL, a durable queue, object storage, secrets management and monitoring in an approved region.

Give each runtime a separate workload identity and network policy. API/worker permissions are scoped to their modules and jobs. AI can read only sanitized jobs and return suggestions; it has no core database, payment or provider execution credentials.

Before deployment, define the jurisdiction and data region, identity provider, queue product, database roles, environment separation, secret rotation, recovery objectives, service limits and protected release pipeline. Production infrastructure-as-code follows those choices.

