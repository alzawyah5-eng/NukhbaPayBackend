# Staff management and master catalogue contracts

Source/offline increment, 19 November 2026. All routes use the existing signed human OIDC access-token verifier and canonical staff resolution. Active authorization phase remains 3A: tenant.staff.read, tenant.audit.read, tenant.access.request, catalog.read and pricing.read remain inactive. Operational requests therefore deny by policy; missing server composition returns 503. Offline success fixtures are isolated future-policy doubles, not an operational authorization switch.

Backend integration uses `createApiApplication({identity, staffAdministration, staffCatalogue})`. Never instantiate a permissive authority in runtime. Catalogue snapshot and read-audit ports require separately approved tenant-aware persistence composition. No browser/BFF forwarding adapter has been authorized for these routes. Existing dashboard login and session behavior is unchanged; browser Origin or Cookie requests are rejected. Tokens must not be added to browser storage or kiosk administration flows.

| Method | Path after /v1/admin/tenants/:tenantId | Contract |
| --- | --- | --- |
| GET | /staff | Safe staff/membership status, role codes and versions; limit 1..50, after UUID |
| GET | /staff/:staffId | Same safe tenant-owned projection, 404 for absent profile |
| GET | /audit | Safe audit metadata, tenant.audit.read, limit/after |
| POST | /staff/requests | Existing non-authorized workflow recording only, 202 after recorded/replayed receipt |
| GET | /catalogue/countries | Reference geography and explicit configured flag |
| GET | /catalogue/services | Explicitly enabled country/service availability |
| GET | /catalogue/providers | Explicitly enabled providers filtered by country/service |
| GET | /catalogue/products | Canonical product search, availability and filtering |
| GET | /catalogue/offers | Private provider cost, freshness, availability; also pricing.read |
| GET | /catalogue/economics | Existing deterministic pricing result, formatted AED fields, canPublish=false; also pricing.read |
| GET | /catalogue/imports | Import status and observation time |
| GET | /catalogue/drafts | Version and publication state; also pricing.read |

Examples for an authorized backend client (placeholder values are not credentials):

```http
GET /v1/admin/tenants/10000000-0000-4000-8000-000000000001/catalogue/providers?country=AE&service=MOBILE_PREPAID&limit=20
Authorization: Bearer <backend-held-approved-human-access-token>
```

Catalogue response shape is `{revision,items,next}`. `next` is an opaque, one-use, actor/tenant/view/query/revision-bound cursor valid for at most 60 seconds and token expiry. Reuse the same filters, limit and sort with `cursor=...`; replay or revision changes return 409. Filters unsupported by a view return 400. countries accepts country/group; services/providers accept country/group/service/provider; products/offers/economics additionally accept product/search; imports accepts provider; drafts accepts product. All views accept sort/limit/cursor. Supported filter values: country, group (GCC/OTHER_ASIA/AFRICA/EUROPE), service, provider, product UUID, search, sort=id|name, limit=1..50. Country identifiers are ISO alpha-2 references from [UN M49](https://unstats.un.org/unsd/methodology/m49/overview/); geography never establishes availability.

Staff request body uses the existing `StaffRequestCommand`: server-selected SUBMIT, UUID key and id, decimal-string version/expectedAuthzVersion/expectedMembershipVersion, previousDigest, UUID targetStaffId, exact operation, proposedRoles and expiresAtMs. Unknown keys, caller MFA/approval/actor fields and unsafe role proposals fail. No invitation is delivered and no staff, membership, grant or session is changed. Lifecycle mutations, privilege delegation and revocation remain blocked by ADR 0013 assurance/approval/executor gates. No activation or publication route was added.

Responses are no-store. 400 malformed or duplicate query/body; 401 absent/invalid identity; 403 permission, tenant or transport denial; 404 unknown profile/route; 409 stale/replayed cursor or conflicting workflow; 503 missing composition, snapshot/audit or authority outage. Credentials, OIDC subjects and tokens are excluded from projections.

Validation: application staff-management and staff-catalogue suites plus API staff-administration-http.spec.ts exercise signed identity, tenant denial, inactive permissions, forged authority, safe projections, filters, cursor replay, audit failure and revocation. These do not establish real Auth0/MFA acceptance or restricted PostgreSQL behavior.


Request recording example (records an unverified intent only):

```json
{
  "key": "10000000-0000-4000-8000-000000000010",
  "id": "10000000-0000-4000-8000-000000000011",
  "version": "1",
  "previousDigest": null,
  "targetStaffId": "10000000-0000-4000-8000-000000000012",
  "operation": {"kind": "SUSPEND", "target": "STAFF"},
  "proposedRoles": [],
  "expectedAuthzVersion": "0",
  "expectedMembershipVersion": "1",
  "expiresAtMs": 1795107600000
}
```

A successful recorded response includes `kind=RECORDED`, `execution=NOT_AUTHORIZED`, `acceptedApproval=false`. Example identifiers and expiry must be replaced with current tenant-owned values by the approved backend. They establish no authority.

## Staff portal forwarding

With explicitly composed backend services, the staff portal accepts same-origin reads at `/staff-api/staff`, `/staff-api/staff/:staffId`, `/staff-api/audit` and `/staff-api/catalogue/:view`. The BFF uses its opaque HTTPS session cookie and resolves the tenant on the server. Staff queries accept `limit` and `after`. Catalogue queries use the central view-specific filters above. The underlying services still decide permissions and record audit before disclosure. The normal CLI starts without these adapters.

## Disposable staff suspension

The optional programmatic portal composes the guarded disposable suspension port. The HTTPS POST at /staff-api/commands/suspension accepts only requestId and idempotencyKey, resolves the canonical request and current approval digest, and returns the approved OIDC step-up location. The OIDC callback rotates the session and makes a short-lived confirmation available to the new cookie. POST /staff-api/commands/suspension/confirm accepts an empty JSON object and requires the new session's CSRF value. The executor repeats current authority, exact request and quorum checks before committing. The normal CLI and production portal do not compose the effect port.
