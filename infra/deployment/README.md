# AWS staging

The deployment target is `https://staging.nukhbapay.com`. The current AWS
project stays on the Free plan with advanced features inactive. Use its assigned
Region only after confirming it is suitable for the staging data. AWS Projects
assigns a fixed Region on this plan. If the data must remain in the UAE, use
local testing while this plan is in place. Staging covers staff sign-in,
catalogue browsing, Finxplor sandbox, iPay UAT and the CurrencyApi.net Layer 1
refresh. The staging DNS change concerns only the `staging.nukhbapay.com` record.
The existing website uses `nukhbapay.com`.

## Staging routes

| URL | Purpose |
| --- | --- |
| `https://staging.nukhbapay.com/management` | Staff sign-in and management workspace. Serve this route and its subpaths through the staff portal. |
| `https://staging.nukhbapay.com/kiosk` | Kiosk preview from its independent frontend build, included in the staging image. |
| `https://nukhbapay.com/` | Existing Coming Soon site, managed independently. |

The staging web listener serves both routes on the same origin. Publishing the
same paths directly on `nukhbapay.com` would require path routing at the current
host for that domain.

The service layout below is provisional. Verify the ECS launch type, load
balancer, RDS PostgreSQL 18 engine and instance size, and networking options
available in the assigned project before creating resources.

The authenticated staging profile is `nukhbapay-staging` in Europe (Stockholm),
`eu-north-1`. The project reported an active Free plan on 28 November 2026.

| Workload | AWS service | Deployment boundary |
| --- | --- | --- |
| React staff frontend and browser API | ECS Fargate behind an HTTPS Application Load Balancer with AWS Certificate Manager | Serve the UI, `/auth/*` and `/staff-api/*` on the same origin. |
| Nest API and provider workers | ECS Fargate and ECR | Run tasks in private subnets with separate task roles and controlled outbound access. |
| PostgreSQL | Private Amazon RDS for PostgreSQL 18 | Preserve the `nukhbapay_catalogue` and `nukhbapay_staff` logical database boundaries. Enable encryption, TLS and backups. Restrict ingress to the relevant workloads. |
| Runtime credentials | AWS Secrets Manager | Give the application and each worker access to its own staging Auth0, database and provider credentials. |
| Scheduled FX sync | EventBridge Scheduler targeting an ECS task | Run at 00:00 and 12:00 in `Asia/Dubai`. Use the same refresh operation for manager-triggered sync. |

If the advisory AI worker is included, give it a separate workload identity and
sanitized jobs. Scope database, provider and payment credentials to their own
workloads.

## Staging infrastructure

- [Foundation template](aws/staging-foundation.yaml) defines the
  `nukhbapay-staging-foundation` stack with an ECS cluster, immutable ECR
  image tags, and short-retention log groups.
- [Database template](aws/staging-database.yaml) defines the
  `nukhbapay-staging-database` stack. The encrypted RDS PostgreSQL 18.7
  instance uses a single `db.t4g.micro` with 20 GiB of storage and private
  subnets. Port 5432 accepts traffic from the staging application security
  group. AWS manages the database administrator credential in Secrets Manager.
  Initialize the staff and catalogue logical databases with separate roles and
  deployment jobs.
- [Build template](aws/staging-build.yaml) runs CodeBuild with a private S3
  source archive and pushes a versioned image to ECR. The packager in
  `scripts/package-aws-staging-source.ps1` takes application source from the
  backend and frontend workspaces. Review the archive before uploading to
  `source/staging.zip`. The staging Dockerfile builds the staff portal and
  kiosk and embeds the regional RDS trust bundle.
- [Release pipeline](aws/staging-release.yaml) builds every current push to
  the `staging` branch in either GitHub repository. The two GitHub Actions
  workflows assume separate short-lived OIDC roles and upload only their own
  versioned source archives. S3 events start CodePipeline with both sources.
  The frontend repository supplies the management UI and kiosk bundles. The
  backend repository supplies the staff API and application runtime. The
  pipeline publishes an immutable image digest and uses that digest to update
  the staging ECS service once its deploy stage is enabled.
- [Network template](aws/staging-network.yaml) provisions the two staging
  application subnets. The RDS instance uses separate private subnets.
- [Catalogue restore template](aws/staging-restore.yaml) registers a one-shot
  Fargate task. It retrieves one checksum-pinned archive from the private
  `restore/` prefix, applies the registered migrations, and imports the selected
  tenant's catalogue in the same transaction. It checks product and price counts
  through the restricted catalogue login. Source archives expire after seven
  days. The task emits aggregate counts to `/nukhbapay/staging/restore`.
- [Service template](aws/staging-service.yaml) accepts the image digest, issued
  certificate, staff and catalogue database secrets, Auth0 test application secret,
  and outputs from the database stack.
  The ALB serves HTTPS on the staging hostname. Its security group is the only
  ingress source for the application's port 8080. The single Fargate task uses
  public IPv4 for outbound access in staging. PostgreSQL remains in its private
  subnets. This keeps staging independent of a NAT gateway.

## Push to staging

Push development changes to the `staging` branch in the affected repository.
The initial release needs a source archive from each branch. Check the build
and ECS rollout in CodePipeline under `nukhbapay-staging-release`. A rapid
sequence of pushes can supersede older candidate releases. The application
rollout reuses the existing RDS database. Apply approved schema changes with
the designated deployment task.

The release stack starts in build-only mode. After the ECS staff service is
healthy, update the stack with `StaffExecutionRoleArn` from the staging
service stack. That enables the ECS deploy action with permission to update
only the staging `staff` service and pass only its task execution role.

Validate and deploy each template to the named project. For example:

```powershell
aws cloudformation deploy --profile nukhbapay-staging --region eu-north-1 `
  --stack-name nukhbapay-staging-foundation `
  --template-file infra/deployment/aws/staging-foundation.yaml
```

## Application and database preparation

1. Start the staging staff runtime with `scripts/start-aws-staging-staff.mjs`
   as the container command. It verifies restricted RDS connections, the
   database schema and grants, and the configured Auth0 issuer before
   serving traffic. The ALB health check uses `GET /health/ready`. Nest and
   provider worker activation are separate release work.
2. Configure the staging Auth0 Regular Web Application. Set the allowed callback to
   `https://staging.nukhbapay.com/auth/callback`, logout URL to
   `https://staging.nukhbapay.com/auth/logged-out`, and web origin to
   `https://staging.nukhbapay.com`. Store its client credential in the staging
   Secrets Manager secret `nukhbapay/staging/staff/auth0` under the JSON key
   `NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET`. Enroll the approved test staff.
3. Run the staging catalogue restore task against the approved snapshot. The
   RDS catalogue database comment is
   `nukhbapay-catalogue-staging:<id>`, with its 32-character hex ID supplied
   in the catalogue reader secret. The [staff database task](aws/staging-staff-database.yaml)
   creates the staff schema and verifies the three restricted runtime roles.
   It expects the staging-only connection strings in
   `nukhbapay/staging/staff/database` and uses the RDS-managed administrator
   secret for setup. Enroll approved staging staff after the schema is ready.
   The staff session schema binds the Auth0 test issuer. The staff, catalogue,
   and Auth0 secrets are separate bindings in the service template.
4. Move the Windows provider launchers and scheduled task into ECS jobs. Preserve
   the Finxplor resume checkpoints, iPay versioned imports, and exact AED
   conversion policy. Verify account scope for each test provider.
5. Build the release from a revision that includes the iPay sync changes.
   Exercise authentication, product paging, manual provider sync, scheduled FX,
   and database restore before switching the staging DNS record.

## Database migration baseline

The read-only catalogue check on 28 November 2026 found PostgreSQL 18.7 and an
87 MB `nukhbapay_catalogue` database with **20,087** observed Finxplor sandbox
products, **5** iPay UAT products, and **23,034** saved Finxplor AED values across
**23,317** source amount rows. Stored historical values can outlast their rate
cycle. Repeat the scoped counts at export and after restore, and compare
currently valid Layer 1 amounts separately. Preserve approved catalogue
observations and migration history. Provision staging-specific role credentials
and staff sessions.

## AWS access and DNS

In AWS Settings, open **Projects**, choose the existing project, then open
**Overview → Additional Info** to confirm its assigned Region. Use the project's
AWS Builder ID session for browser-based CLI access with
`aws login --profile nukhbapay-staging` when the CLI is available. Choose the
existing project in the browser. Confirm the profile's Region matches the
project before inspecting resources. Check the Free plan balance and expiry in
Billing, and keep a separate backup of any staging data that must outlast the
project's Free plan. Use the existing DNS administrator for ACM validation and
the staging record.

The non-exportable ACM certificate for `staging.nukhbapay.com` was requested
in `eu-north-1`. Use its DNS validation CNAME in the authoritative DNS zone.
Add the staging traffic record after the certificate is issued and the
application load balancer is ready.

- [Find the Region assigned to an AWS project](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Connect a coding tool to an existing AWS project](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html)
- [AWS Projects Free Tier services and limits](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html)
- [AWS Free plan duration and credits](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
- [Import data to Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Procedural.Importing.html)
- [Validate ACM certificates with DNS](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [Schedule ECS tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduling_tasks.html)
