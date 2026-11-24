# Provider adapters

The in-memory synthetic catalogue feeds the existing pricing fixtures. `SslWirelessCatalogue` discovers services and packages. `IronGateCatalogue` discovers prepaid, postpaid, game and eSIM metadata. Both pin an HTTPS origin, tenant and provider account, and use a server-owned credential resolver. The current outputs are scoped source observations. Canonical offer mapping requires verified source identifiers, debit/fees, currency, expiry and availability. [SSL source coverage](../../docs/providers/ssl-wireless-common-api.md) · [Provider pack coverage](../../docs/providers/provider-api-pack-1.3.md)

Future real adapters belong in separate directories here, one per provider, behind the contracts package. Own provider authentication, schema validation, throttling, timeout semantics, callback verification, and provider-specific error translation in that adapter. Keep provider credentials and raw private data out of public API contracts and AI jobs.

The integration path is backend provider adapter → fenced canonical catalogue snapshot → exact backend pricing → controlled immutable publication → scoped payment and kiosk catalogue APIs. Configure provider adapters only in an approved backend composition. Fulfilment requires its own authorized contract with stable request identifiers, provider idempotency, status lookup and explicit unknown outcomes.

The synthetic prices are AED 97.00 for A, AED 96.50 plus AED 0.80 for B, and AED 95.80 for unavailable C. A is selected by effective eligible cost.
