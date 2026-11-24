# NukhbaPay Backend — Core API, AI Service & Infrastructure Platform

[![CI/CD Pipeline](https://github.com/alzawyah5-eng/NukhbaPayBackend/actions/workflows/ci.yml/badge.svg)](https://github.com/alzawyah5-eng/NukhbaPayBackend/actions/workflows/ci.yml)
[![Node Version](https://img.shields.io/badge/Node-24.x-brightgreen.svg)](https://nodejs.org/)
[![pnpm Version](https://img.shields.io/badge/pnpm-10.x-orange.svg)](https://pnpm.io/)
[![Python Version](https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-blue.svg)](https://python.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11.x-E0234E.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16.x-336791.svg)](https://postgresql.org/)

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
├── infra/                       # Local Docker Compose (PostgreSQL 16, Redis, Local Stack)
├── scripts/                     # DB migration rehearsal, Auth0 enrollment, verification suites
├── docs/                        # Architecture Decision Records (ADRs), runbooks, security profiles
└── tests/                       # Acceptance and integration test suites
```

---

## ⚡ Key Highlights & Principles

1. **Exact Financial Mathematics**: Zero IEEE-754 floating-point drift. All money calculations in AED are stored and computed in integer minor units (fills) with explicit half-up rounding.
2. **Hard Equivalence AI Guards**: AI models (Gemini / Claude / local models) provide *advisory suggestions only*. Hard deterministic parameter guards verify brand, currency, country code, face value, and restrictions before any catalog mapping can be published.
3. **Deny-by-Default Identity**: Zero anonymous endpoints except verified liveness (`GET /health`). Staff sessions are actor/version-bound with MFA observation.
4. **Disposable Migration Acceptance**: Database migrations (001–006) are tested against ephemeral random target databases before promotion.
5. **Audited Transactional Outbox**: Atomic database state mutation with outbox records ensuring reliable messaging and reconciliation.

---

## 🚀 Quick Start & Installation

### Prerequisites

- **Node.js**: `v24.x` (pinned in `.node-version`)
- **pnpm**: `v10.x` (`corepack enable` or `npm install -g pnpm`)
- **Python**: `3.11+` or `3.12+` or `3.13+`
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

Review database credentials, API host, port, and Auth0 settings in `.env`.

---

## 🧪 Running Verification & Tests

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
API binds to `http://127.0.0.1:3000` by default.

### Start Local Infrastructure (PostgreSQL & Redis)
```bash
docker compose -f infra/local/docker-compose.yml up -d
```

### Database Migrations
```bash
# Run verified migrations against configured database
pnpm db:migrate
```

---

## 🔄 CI/CD Pipeline

The repository includes a comprehensive **GitHub Actions CI/CD pipeline** (`.github/workflows/ci.yml`):

- **Node.js Test Matrix**: Pinned dependency caching, domain & provider tests, TypeScript compile-time typecheck, and application builds.
- **Python AI Suite**: Runs AI gateway and equivalence guard unit tests.
- **Scaffold Check**: Automatically enforces architecture boundaries on every PR.
- **Docker Compose Validation**: Ensures infrastructure definitions are syntax-valid.

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
