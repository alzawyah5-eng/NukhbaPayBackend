# NukhbaPay Backend — Core API, AI Service & Infrastructure Platform

[![Backend CI](https://github.com/alzawyah5-eng/NukhbaPayBackend/actions/workflows/ci.yml/badge.svg)](https://github.com/alzawyah5-eng/NukhbaPayBackend/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/Node-24.x-brightgreen.svg)](https://nodejs.org/)
[![pnpm Version](https://img.shields.io/badge/pnpm-10.x-orange.svg)](https://pnpm.io/)
[![Python Version](https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-blue.svg)](https://python.org/)
[![NestJS](https://img.shields.io/badge/NestJS-12.x-E0234E.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17%20%7C%2018-336791.svg)](https://postgresql.org/)

The enterprise financial backend for the **NukhbaPay** digital goods, gift cards, and payments platform. Follows strict Hexagonal (Ports & Adapters) and Clean Architecture boundaries with exact minor-unit financial arithmetic, AI-assisted catalog matching with hard parameter guards, immutable transaction outbox, and zero-trust IAM.

---

## 🏗️ Architecture & Component Overview

```text
backend/
├── apps/
│   ├── api/                     # NestJS Core HTTP API (Identity, Catalogue, Public Liveness, Guards)
│   ├── ai-service/              # Python AI Matching, Model Gateways & Catalog Equivalence Guards
│   ├── worker/                  # Background Worker (Outbox delivery, async jobs)
│   └── admin-web/               # Node.js HTTPS BFF Portal (Auth0, Step-up MFA, Sessions)
├── packages/
│   ├── domain/                  # Pure TypeScript domain models, exact AED pricing arithmetic
│   ├── application/             # Use cases, approval intake, catalog publication, synthetic assurance
│   ├── database/                # PostgreSQL repositories, connection pools, migrations 001–006
│   ├── contracts/               # Shared TypeScript schemas and RPC boundaries
│   ├── provider-adapters/       # Integrations for upstream providers (IronGate, SSL Wireless, Sandbox)
│   └── provider-contracts/      # Formal vendor API contracts and normalization types
├── infra/                       # Local Docker Compose for PostgreSQL and Redis
├── scripts/                     # DB migration rehearsal, Auth0 enrollment, verification suites
├── docs/                        # Architecture Decision Records (ADRs), runbooks, security profiles
└── tests/                       # Acceptance and integration test suites
```

---

## ⚡ Key Highlights & Principles

1. **Exact Financial Mathematics**: Zero IEEE-754 floating-point drift. All money calculations in AED are stored and computed in integer minor units (fills) with explicit half-up rounding.
2. **Hard Equivalence AI Guards**: AI models (Gemini / Claude / local models) provide *advisory suggestions only*. Hard deterministic parameter guards verify brand, currency, country code, face value, and restrictions before any catalog mapping can be published.
3. **Deny-by-Default Identity**: Staff and catalogue routes require the appropriate identity and scope. Process liveness is available at `GET /health/live`.
4. **Disposable Migration Acceptance**: Database migrations (001–006) are tested against ephemeral random target databases before promotion.
5. **Audited Transactional Outbox**: Atomic database state mutation with outbox records ensuring reliable messaging and reconciliation.

---

## 🚀 Quick Start & Installation

### Prerequisites

- **Node.js**: `v24.x` (pinned in `.node-version`)
- **pnpm**: `v10.x` (`corepack enable` or `npm install -g pnpm`)
- **Python 3.12** for the CI AI suite. A local Python installation is also needed for architecture and offline checks.
- **Docker**: For local PostgreSQL and Redis (optional for offline tests)

### 1. Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/alzawyah5-eng/NukhbaPayBackend.git
cd NukhbaPayBackend

# Install pinned workspace dependencies
pnpm install --frozen-lockfile
```

### 2. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

The default API and offline tests can run without a database. Use the example for local configuration when a runbook calls for it. Provide private staff settings through the staff launcher prompts.

---

## 🧪 Running Verification & Tests

Run the full offline build and regression suite from the repository root:

```bash
pnpm development:test:offline
```

It saves local evidence under `.local/`. PostgreSQL and real-provider acceptance have separate qualification commands.

### Offline Financial & Provider Tests
Runs exact financial calculations and vendor integration adapters in memory without requiring a database:

```bash
pnpm test
```

### Python AI Service & Equivalence Tests
Runs 30 unit tests covering confidence review, circuit breaker fallback, hard mismatch rejections, and catalog normalization:

```bash
pnpm test:ai
# or: python -m unittest discover -s apps/ai-service/tests -v
```

### Architecture Scaffold Validation
Validates package structure, boundaries, and prevents forbidden circular or privileged imports:

```bash
pnpm check:architecture
# or: python scripts/check_structure.py
```

### Financial Pricing Simulation Demo
Runs an offline simulation of provider comparison, waterfall calculations, contribution margins, and customer quote generation:

```bash
pnpm demo
```

---

## 🖥️ Running Services

### Start NestJS API
```bash
# Build all dependent packages and API
pnpm api:build

# Run API in development
pnpm api:start
```
The API binds to `http://127.0.0.1:3000` by default. Check `/health/live` to verify startup.

With the Windows Staff Portal running, set `$env:API_HEALTH_MODE = 'windows-staff-postgresql'` in the API's PowerShell terminal before starting it. In this loopback mode, `/health/live` returns `200 {"status":"ok","database":"connected"}` when the portal's live PostgreSQL checks pass. A failed or unreachable storage check returns `503 {"status":"unavailable","database":"unavailable"}`.

### Start the Windows Staff Portal

With the existing local database inspection, enrollment, and build in place, run this from the workspace folder that contains `backend`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\backend\scripts\staff-local.ps1
```

First-time setup collects credentials at hidden prompts. After preflight passes, Windows encrypts the saved settings for your account using DPAPI under `%LOCALAPPDATA%\Nukhbapay\staff-portal\windows-staff.clixml`. Start the launcher again from the same Windows account to reuse them. Append `-Check` to verify a saved setup without starting the portal, or `-Configure` to re-enter the settings after credentials rotate. Open `https://localhost:3001/login` once the launcher prints the link. [Windows Auth0 and PostgreSQL runbook](docs/runbooks/staff-auth0-local-test.md)

### Local infrastructure

The Compose development stack uses PostgreSQL 17 and optional Redis. The Windows Staff Portal uses the separately configured PostgreSQL 18 service. Follow the [local infrastructure runbook](infra/local/README.md) when selecting a target and port.

### Database migrations

Verify frozen migration sources with `pnpm db:verify:sources`. Use the [migration rehearsal runbook](docs/security/migration-security-rehearsal.md) to apply migrations on its approved disposable target.

Use the [local Master Catalogue runbook](docs/runbooks/local-master-catalogue.md) for the separate Windows development catalogue database.

---

## CI and release

GitHub Actions runs the following checks for pushes and pull requests to `main`:

- **Node.js Test Matrix**: Pinned dependency caching, domain & provider tests, TypeScript compile-time typecheck, and application builds.
- **Python AI Suite**: Runs AI gateway and equivalence guard unit tests.
- **Scaffold Check**: Automatically enforces architecture boundaries on every PR.
- **Docker Compose Validation**: Ensures infrastructure definitions are syntax-valid.

Deployment and operational acceptance are separate from commit validation.

---

## 🔒 Security Runbooks & Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [Project Inventory & Structure](docs/project-structure.md)
- [Verification Evidence & Limits](docs/verification.md)
- [ADR Index (Decisions 0001–0026)](docs/adr/)
- [Migration Rehearsal Runbook](docs/security/migration-security-rehearsal.md)

---

## 📄 License & Ownership

Proprietary © NukhbaPay. All rights reserved.
