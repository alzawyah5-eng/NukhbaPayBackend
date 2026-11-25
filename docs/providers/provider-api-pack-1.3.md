# Provider API pack 1.3 coverage

`SYMH/APIs/NukhbaPay_Provider_API_Pack_v1.zip` identifies itself as edition `1.3`, updated November 18 and reissued November 20, 2026. The ZIP SHA-256 is `d4b918b6fff0a44525e0d14d39fdc3820bee20456c1148c9653b718da1b751df`. All five files listed in `NukhbaPay_MANIFEST.json` match their lengths and hashes. The 119 operation records in `NukhbaPay_API_Extraction.json` are a project extraction, including documentary variants. The archive contains no original vendor PDFs, screenshots, OpenAPI or Postman collection. Original SSL and iPay PDFs are separately available in `SYMH/APIs`. The archive's instructions and tooling examples were treated as reference text.

| Provider | Pack records | Catalogue coverage |
| --- | ---: | --- |
| Finxplor Connect | 14 | Product listing verified by the local sandbox import. Product detail catalogue projection mock verified. |
| IronGate Digital | 67 | Seven catalogue and game metadata operations are locally implemented and mock-tested. A legacy price-list operation is recorded separately. |
| SSL Wireless | 16 | Three catalogue operations across two original Common API editions are locally implemented and mock-tested. The count includes multiple biller profiles for other operations. [SSL edition coverage](ssl-wireless-common-api.md) |
| iPay/Qore3 | 22 | Thirteen scoped SOAP operation records mock-tested. Account activation remains deferred. |

The [full inventory](provider-api-inventory.md) gives the backend status for all 119 operation records and both IronGate webhook definitions.

Backend wire adapters additionally cover the documented SSL transaction profiles and IronGate prepaid, legacy v1 and postpaid forms. Transaction clients require injected server-side credentials and transport. They send one attempt and preserve provider amounts and large references as text. Unknown responses yield an unconfirmed outcome. Production composition must bind authorization, approved product and customer scope, durable attempt state, status reconciliation and controlled fulfilment. The IronGate callback verifiers correlate callbacks with a trusted attempt and trigger a status recheck only. [SSL bills](../../packages/provider-adapters/src/ssl-wireless-bills.ts) · [IronGate prepaid](../../packages/provider-adapters/src/irongate-prepaid.ts) · [IronGate postpaid](../../packages/provider-adapters/src/irongate-postpaid.ts) · [Callback verifier](../../packages/provider-adapters/src/irongate-callback.ts)

## Finxplor Connect

The dedicated sandbox importer uses `FinxplorCatalogue.page` and `fullCatalogue` for `GET /api/v1/products`. `FinxplorCatalogue.detail` projects catalogue fields from `data.product`. The sandbox test qualified product `1002_1643` with a denomination of 398 BDT. Both adapter paths preserve denominations as exact decimals. The commercial debit, fee, FX and entitlement contract remains required for pricing or execution. [Adapter](../../packages/provider-adapters/src/finxplor-catalogue.ts)

The collapsed screenshot panels reference F CONNECT API v1. These paths are an endpoint inventory. The initial pack supplies no catalogue payload examples. The product detail entry identifies `productId` as an encoded identifier. An API key is shown as a requirement. Its header, scope, host, key rotation, supported countries, product families, availability, debit and fees, currency field types and scale, pagination, rate limits, retry and error behavior still need the expanded vendor specification.

| Pack ID | Method and path | Purpose |
| --- | --- | --- |
| `FINXPLOR-005` | `GET /api/v1/transfers/payout-routes` | Payout-route discovery. The availability and quote schemas are pending. |
| `FINXPLOR-006` | `GET /api/v1/products` | Digital catalogue. Filter names and response shape are pending. |
| `FINXPLOR-007` | `GET /api/v1/products/:productId` | Detail by encoded product identifier. |
| `FINXPLOR-013` | `GET /api/v1/currencies` | Supported currencies. Identifiers, precision and eligibility schema are pending. |

All 14 Finxplor rows in the original missing-data tracker correspond to the 14 extracted route records. For the four catalogue reads, that archive captures only the `productId` path placeholder and zero response-field rows. The owner subsequently supplied an expanded F CONNECT API v1 documentation screenshot. It is supplemental evidence, separate from the edition 1.3 archive.

| Expanded screenshot evidence | Read contract now visible |
| --- | --- |
| `GET /api/v1/transfers/payout-routes` | Country and currency query filters. The example includes route-level country, currency and delivery method information. |
| `GET /api/v1/products` | Pagination (`page`, `limit`) and `country`, `category` and `search` filters. The example includes product identifiers, brand, country, currency, denomination information and pagination. |
| `GET /api/v1/products/:productId` | Encoded identifier in the path. The detail example includes product data and `request_attributes` describing purchase-time input requirements. Treat these as declarative metadata within the catalogue; keep purchase routes outside the approved surface. |
| `GET /api/v1/currencies` | Reference response describing supported currencies and groups for supported services. Do not treat reference coverage as proof of account entitlement. |

The page shows API-key authentication in a request header and describes per-family limits and rate-limit errors. The key shown in the screenshot was excluded from project files and was never used. The owner should rotate it through the approved secret store if it is active. The authorized folders supplied no newer typed Finxplor contract. Before adapter work, obtain a readable sanitized export of the current contract. Confirm the exact header spelling, approved sandbox origin and account, stable ID encoding, typed success/error and pagination schemas, entitlement and availability fields, currency precision, provider debit and fees, and the exact limits and retry headers. Financial operation examples establish no execution approval.

## IronGate Digital / IDSL

The pack transcribes prepaid v2 and shared postpaid request and response tables from named provider documentation pages. The documentation URLs identify the tables, while the operation paths below identify the transport contract. The adapter uses JSON, a configured HTTPS origin and a pinned tenant and provider account. Each approved operation requires a separately confirmed provider success code for `data.rc`. Required request fields are `username` and `sign`. The source defines `sign` as MD5 over the concatenation of the username, API key and operation suffix. Keep the API key in the backend resolver and send the signed payload only to the approved origin. These vendor signatures require TLS and must be excluded from diagnostic output.

| Pack ID | POST path and request | Projected response fields |
| --- | --- | --- |
| `IRONGATE-002` | `/api/pricelist`, suffix `pl`, pinned `currency` of `IDR` or `USD`. Source also documents optional status and path filters. | `data.pricelist[]` with `product_code`, description, nominal string, numeric `product_price`, currency, status, type, category and active period. |
| `IRONGATE-003` | `/api/gamelist`, suffix `gc`. | `data.gamelist[]` with integer `game_code` preserved as text and `name`. |
| `IRONGATE-005` | `/api/esimlist/:operator`, suffix `esim`, account-pinned operator. | Counts validated rows in `data.esimlist[]`. The documented inventory `number` stays private. |
| `IRONGATE-006` | `/api/esiminternationallist`, suffix `esim-inter`. The source also documents optional `local`, `regional`, `global` and language selectors. | `data.list[]` with `slug`, name, coverage type and nested country name and source code. Drops icon URLs. |
| `IRONGATE-010` | `/api/game/format`, account-pinned string `game_code` used as the signature suffix. | `data.formatGameId` from a successful response. |
| `IRONGATE-011` | `/api/inquiry-game-server`, account-pinned string `game_code` used as the signature suffix. | `data.servers[]` with `name` and unique string `value` from a successful response. |
| `IRONGATE-019` | `/api/v1/bill/check`, suffix `pl`, fixed `commands` value `pricelist-pasca`. The source also documents optional status, province and type filters. | `data.pasca[]` with `code`, name, status (`1` active, `4` non-active), numeric `fee` and `komisi`, type, category and optional province. |

The `IRONGATE-024` legacy price list uses `POST /v1/legacy/index` with the documented `pricelist` selector and separate response profile. Its optional path filters and ambiguous inactive status token require the native specification. The source identifies v1 as deprecated and recommends v2 for new work. The operator and catalogue scopes remain pinned. Subscriber, balance, purchase, postpaid payment and notification wire adapters belong to separately authorized transaction workflows.

Prepaid price, postpaid fee and commission are preserved as exact JSON number text. The pilot must confirm the relationship between `product_price` and actual debit, the fee and commission currency, tax, fees, rounding, offer validity, active status encodings, countries, eligible categories and account. Confirm the success discriminant for each read, including the postpaid envelope, which the source describes chiefly through `data.pasca`. The test fixtures use a synthetic success code. The pack does not establish pagination, rate limits or safe automatic retry. The adapter bounds time and response size, denies redirects and sends a single request per invocation. [Adapter](../../packages/provider-adapters/src/irongate-catalogue.ts) · [Loopback tests](../../packages/provider-adapters/test/irongate-catalogue.test.ts)

## iPay / Qore3

The original `iPay API SDK  v2.0.1.pdf` is the Qore3 API SDK 2017 and SHA-256 `db0ea6442d4103335cd7c92da42c0673a6ae6aea5a2959096946e1222684ce59`. The transport is `/Web/Get` or `/Web/GetXml` with `RequestXml` in the query, or SOAP 1.1 `Process(RequestXml As String)` at `/ecsoap`. `TerminalId` and `Password` are part of the XML. URL-based authentication carries those credentials in a request URL and is unsuitable here.

| Pack ID | Source operation | Catalogue fields and missing inputs |
| --- | --- | --- |
| `IPAY-007` | `FileDownload`, SDK section 7 | `FileType=1` selects product XML. The adapter checks the configured product root, assigned group and response version, then projects product codes, source types, UPCs, denominations and limits. The actual root and XML encoding require an account sample. |
| `IPAY-022` | `PinAvlb` / `pinavlb`, SDK section 18 | The account binding pins the exact selector spelling. The original SDK example confirms `StatusCode=0` and `StatusDescription=Pin is available` for a positive result. Other outcomes remain unconfirmed. |

The provider package exports `@nukhbapay/provider-adapters/ipay`. The HTTPS SOAP 1.1 `Process` transport pins the exact endpoint, action, and request/result namespaces. It rejects redirects, DTD declarations and responses with the wrong wrapper. The SDK also supports `IPAY-006` balance, `IPAY-018` PIN/PINless query by the original reference for an existing provider transaction, and `IPAY-019` version. Mock tests exercise credential escaping, text amounts, file scope and response correlation. Activation still needs the assigned HTTPS WSDL, vendor response examples, and an authorized account. [SDK adapter](../../packages/provider-adapters/src/ipay-sdk.ts) · [SOAP transport](../../packages/provider-adapters/src/ipay-soap.ts)

The original manual, PDF pages 9–18 and 41–42, also supports these forms.

| Record | Implemented scope |
| --- | --- |
| `IPAY-001` | `PinRequest` with an approved product, receipt, reference and value code. The decoder transfers the issued PIN once to a protected fulfilment store. The returned receipt is a UUID. |
| `IPAY-002` | `PinlessRequest` for the reserved `REFUND` product. `CardData` is the original provider transaction number and `Amount` is fixed at `0`. Refunds by order number await account-specific qualification. |
| `IPAY-003` / `IPAY-004` | Account-number `PinlessRequest` and `PinlessRequest2ndStep` for pinned products. A successful response with a blank authorization code indicates confirmation is required. The confirmation form repeats the admitted fields. Its first-step transaction number is supplied only to the trusted reservation port. |
| `IPAY-005` | eCash transfer to a merchant identified by `TransRef`. The trusted terminal profile pins the assigned code because SDK pages 20–21 show `EFRDEP` in the table and `EFECSH` in the example. A confirmation uses the same admitted fields. |
| `IPAY-016` | `GetLastTrans` returns a scoped product and amount summary. Voucher, customer and receipt fields stay out of the result. |
| `IPAY-015` | `ChangeStPass` accepts an atomic reservation for the exact account, terminal and prepared numeric password under the SDK's 4–20 digit constraint. A vendor acknowledgement is recorded against that reservation. Timeout and local commit failure leave the result unconfirmed. See SDK page 41. |
| `IPAY-017` | eCash cash and cheque collection from the merchant identified by `TransRef`. Each terminal profile pins its assigned product and selector. The cheque variant includes `ChequeInfo` with the number, ISO calendar date and bank name. A second step requires the same admitted fields. See SDK pages 43–47. |

The backend providing `reserveMutation` must atomically authorize each exact request, reject duplicate money movement, and check the persisted first-step observation before admitting confirmation. A transport or fulfilment-store error yields an unconfirmed outcome. Reconciliation remains a separate operation against the original reference. [Wire contract tests](../../packages/provider-adapters/test/ipay-transactions.test.ts)

The documented families include PINs, fixed and variable top-up, POS activation and bill pay. Before implementing an iPay read, obtain an approved current HTTPS SOAP WSDL and sanitized successful and denied responses or an authenticated product-file feed. Confirm case and selectors, assigned countries and catalogues, currency, precision, actual debit and fees, availability, error handling, rate limits and retry behavior. The separate test-credential PDF was identified by filename.

## Central catalogue boundary

Backend provider reads produce scoped discovery. Reviewed mapping supplies approved canonical product and offer identifiers, expiry, currency and exact debit/fee units before a fenced import can create a completed snapshot. The pricing engine works on normalized minor units. Controlled publication creates immutable revisions. Payment-backend and kiosk-machine clients use the scoped NukhbaPay published catalogue API. Current vendor discovery classes have no canonical importer or publication dependency. Operational acceptance still requires provider account evidence and external client scope ownership. [Public API contract](../security/brick4b-published-catalogue-api.md) · [Browser boundary tests](../../scripts/test/browser-boundary.test.mjs)
