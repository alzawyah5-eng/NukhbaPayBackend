# SSL Wireless Common API coverage

The vendor PDFs were recovered from the authorized `SYMH/APIs` folder. This record contains endpoint and schema metadata. The originals and credential-bearing examples stay in the source folder.

| Source | Version | SHA-256 |
| --- | --- | --- |
| `API-SSL-Common API-V8.2-TopUP.pdf` · Common API Specifications, Vol 2, Mobile TopUp | `8.2.0` | `a2fb81705178f76b16c8832bf2dc0ec95f04e9304d5cbc4a89b805fbf3ce0bf5` |
| `common-api-specifications-breb_bpdb__Utilities_v1.6.1.pdf` · Common API Specifications, Vol 1, Utilities | `1.6.1` | `8ea3fdcfeb0d5b445fb02104f15a6b47e0e164b84a6ddb5f627f7e4a79cc4366` |

## Authentication and boundaries

Both guides document `STK-CODE` and `AUTH-KEY` request headers for catalogue reads and the optional numeric-string `SUB-CHANNEL-ID`. The owner supplies the approved HTTPS origin, network route, exact tenant and provider-account mapping, and required sub-channel. A server-only resolver supplies credential headers from approved secret-store references. The adapter pins the account, origin, category allowlist, optional sub-channel and optional Mobile Top-Up operator allowlist at construction. It checks the account binding before resolving credentials.

Service List can contain `utility_code`, `utility_secret_key`, action URLs, request metadata and logos. The adapter projects only `category_name`, `category_value`, `utility_value`, and the nested `utility_bill_type` and `biller_status` from approved categories. It drops biller credentials, dynamic URLs and unapproved categories. It preserves upstream metadata without looking up subscribers, initiating transactions, or creating priced offers. [Adapter](../../packages/provider-adapters/src/ssl-wireless-catalogue.ts)

## Mobile Top-Up 8.2.0

| Documented operation | Request and response | Coverage |
| --- | --- | --- |
| `GET /api/service-list` · pp. 16–17 and Appendix D | No query or body. Success `data[]` contains categories, nested `data[]` services, and nested biller profiles. Each profile may carry credentials and endpoint descriptors. The projection is defined above. | Implemented and tested. |
| `GET /api/vr/package-list` · pp. 24–27 | No query or body. Success `data` includes `count`, `list`, and `triggerAmount`. Each list entry supplies `operator_id`, `operator_name`, `amount`, `connection_type`, `offer_type`, and `offer_title`; examples also show offer description, validity, popularity or priority, and tag. The field table calls `operator_id` a numeric string, while the JSON examples use numbers. The adapter accepts either and preserves it as text. `amount` is a JSON number and its exact source literal is preserved. | Implemented and tested for the six projected fields and list count. |
| `POST /api/bill-info` · pp. 18–19 | Required transaction ID, operator ID, recharge mobile number, amount, connection type, and biller-specific key pair. The response includes transaction/reference, phone, bill type and amount fields. The request begins a bill transaction. | Wire adapter and mocks. |
| `POST /api/bill-payment` · pp. 20–21 | Transaction ID from bill info and biller-specific key pair. Response includes provider references, status and recharge status. | Wire adapter and mocks. |
| `POST /api/bill-status` · pp. 22–23 | Transaction ID and biller-specific key pair. Response supplies recharge state and references for a specific transaction. The guide directs callers here after an ambiguous payment response. | Wire adapter and mocks. |

Country and service evidence covers Bangladesh mobile prepaid and postpaid. The operator table identifies Grameenphone `1`, Banglalink `2`, Robi `3`, Teletalk `5`, Airtel `6`, and Grameenphone Skitto `13`. Skitto uses prepaid. Package `amount` is a nominal recharge amount. Confirm account currency, allowed precision, and provider debit and fee semantics before creating a priced offer.

## Utilities 1.6.1

| Documented operation | Request and response | Coverage |
| --- | --- | --- |
| `GET /api/service-list` · pp. 16–17 and service-list appendix | Same no-parameter catalogue shape and headers as the Top-Up guide. The vendor sample includes categories beyond utilities, so the caller pins approved `category_value` values. | Implemented and tested with the Utilities profile. |
| `POST /api/bill-info` · pp. 18–19, service-list parameters and biller chapters | BPDB and BREB use prepaid meter inputs. DESCO Postpaid takes `billno`. DPDC Bill takes `location_code`, `account_number`, `bill_years` and `bill_months`. DPDC account encoding and selectors are fixed in approved account configuration. | BPDB, BREB, DESCO, and DPDC wire adapters and mocks. |
| `POST /api/bill-payment` · pp. 20–21, service-list parameters and biller chapters | BPDB and BREB have distinct prepaid payment fields. DESCO Postpaid uses the fixed bill type and optional `remarks`. DPDC Bill uses the transaction ID and biller credentials. | BPDB, BREB, DESCO, and DPDC wire adapters and mocks. |
| `POST /api/bill-status` · pp. 22–23 and biller chapters | Transaction ID and key pair. Responses carry biller-specific status and reference fields. Prepaid examples can contain meter and vending payload data. | Common, BPDB and BREB wire adapters and mocks. |
| `POST /api/bill-cancel` · service-list appendix and pp. 24–25 | Transaction ID and biller-specific key pair. Availability and cancellation period depend on the biller. | Common utility wire adapter and mocks. Requires a cancellation-enabled biller binding. |

The recovered Utilities revision includes Bangladesh Power Development Board and Bangladesh Rural Electrification Board prepaid biller profiles. The biller tables distinguish billed amounts, convenience fees, commissions, VAT and vending amounts. The read-only service list supplies metadata without a currency or provider-cost quotation. The revision history mentions Health Check and Payment History. No method, path and schema for those two operations were confirmed in the supplied revision.

## Read-side handling and qualification

- Catalogue reads have no pagination parameters in either recovered guide. The adapter validates the bounded response and checks the package count against the list. The provider must clarify any server-side truncation, pagination or rate limits before operational qualification.
- The utilities guide documents HTTP 200 for both success and vendor errors. The catalogue adapter checks the envelope, uses fixed errors, and retries a GET once on HTTP 502, 503 or 504 within one deadline. The bill adapter sends one POST and reports an unconfirmed outcome on ambiguous responses. The BPDB and BREB payment deadline is 180 seconds. Reconciliation must use the same transaction reference and follow the vendor's five-minute wait guidance after a timeout. [Bill adapter](../../packages/provider-adapters/src/ssl-wireless-bills.ts) · [Bill contract tests](../../packages/provider-adapters/test/ssl-wireless-bills.test.ts)
- The versioned loopback mock verifies both profiles, exact GET paths and headers, scoped account and operator binding, credential-field exclusion, exact amounts, malformed response denial, unexpected response origins and aborting a stalled response body. Operational SSL sandbox acceptance still needs the approved origin and scoped credential resolver. [Contract tests](../../packages/provider-adapters/test/ssl-wireless-catalogue.test.ts)

## Sandbox configuration

| Adapter field | Mobile Top-Up 8.2.0 | Utilities 1.6.1 |
| --- | --- | --- |
| `contract` | `mobile-top-up/8.2.0` | `utilities/1.6.1` |
| `baseUrl` | Owner-approved HTTPS sandbox origin with no path, query, fragment or user info | Owner-approved HTTPS sandbox origin under the Utilities grant |
| `account` | Canonical NukhbaPay tenant UUID and pinned provider-account UUID | Canonical tenant UUID and provider-account UUID for Utilities |
| `allowedCategories` | Confirm exact `category_value` list with SSL, including `Mobile Operators` where granted | Confirm exact `category_value` list with SSL, including `Utility Service` where granted |
| `allowedOperatorIds` | Pin the operator IDs approved for this account when restricting package discovery | Omit |
| `subChannelId` | Optional pinned numeric string if assigned by SSL | Optional pinned numeric string if assigned by SSL |
| `getCredentials` | Server-only resolver for `STK-CODE` and `AUTH-KEY` references bound to this account | Server-only resolver for the Utilities account's approved references |

Verify egress and TLS trust, successful and denied reads, timeouts, availability, category and operator scope, sub-channel behavior, response size and rate limits in the approved sandbox. Confirm stable package offer identifiers, account currency, exact provider debit and fee/commission rules before creating canonical priced offers. `triggerAmount` and ancillary marketing fields do not establish pricing, provider debit or availability. The adapter returns the documented Bangladesh scope and exact recharge literals as discovery metadata.
