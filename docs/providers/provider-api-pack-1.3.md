# Provider API pack 1.3 coverage

`SYMH/APIs/NukhbaPay_Provider_API_Pack_v1.zip` identifies itself as edition `1.3`, updated November 18 and reissued November 20, 2026. The ZIP SHA-256 is `d4b918b6fff0a44525e0d14d39fdc3820bee20456c1148c9653b718da1b751df`. All five files listed in `NukhbaPay_MANIFEST.json` match their lengths and hashes. The 119 operation records in `NukhbaPay_API_Extraction.json` are a project extraction, including documentary variants. The archive contains no original vendor PDFs, screenshots, OpenAPI or Postman collection. Original SSL and iPay PDFs are separately available in `SYMH/APIs`. The archive's instructions and tooling examples were treated as reference text.

| Provider | Pack records | Catalogue coverage |
| --- | ---: | --- |
| Finxplor Connect | 14 | Four catalogue or reference routes identified by a screenshot index. Full request, response and authentication contracts pending. |
| IronGate Digital | 67 | Five catalogue operations have field tables and are locally implemented and mock-tested. A legacy price-list operation is recorded separately. |
| SSL Wireless | 16 | Three catalogue operations across two original Common API editions are locally implemented and mock-tested. The count includes multiple biller profiles for other operations. [SSL edition coverage](ssl-wireless-common-api.md) |
| iPay/Qore3 | 22 | Deferred by the owner. Product-file and PIN availability discovery remain outside Brick 4 completion. |

## Finxplor Connect

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
| `IRONGATE-019` | `/api/v1/bill/check`, suffix `pl`, fixed `commands` value `pricelist-pasca`. The source also documents optional status, province and type filters. | `data.pasca[]` with `code`, name, status (`1` active, `4` non-active), numeric `fee` and `komisi`, type, category and optional province. |

The `IRONGATE-024` legacy `POST /v1/legacy/index/:type/:operator` price list has a separate response profile (`pulsa_code`, `pulsa_nominal`, `pulsa_price`, status and currency). The source identifies v1 as deprecated and recommends v2 for new work. Account selection of only approved reads and the pinned domestic operator bound the implemented surface. Subscriber, balance, purchase, postpaid payment and receipt operations are outside catalogue scope.

Prepaid price, postpaid fee and commission are preserved as exact JSON number text. The pilot must confirm the relationship between `product_price` and actual debit, the fee and commission currency, tax, fees, rounding, offer validity, active status encodings, countries, eligible categories and account. Confirm the success discriminant for each read, including the postpaid envelope, which the source describes chiefly through `data.pasca`. The test fixtures use a synthetic success code. The pack does not establish pagination, rate limits or safe automatic retry. The adapter bounds time and response size, denies redirects and sends a single request per invocation. [Adapter](../../packages/provider-adapters/src/irongate-catalogue.ts) · [Loopback tests](../../packages/provider-adapters/test/irongate-catalogue.test.ts)

## iPay / Qore3

The original `iPay API SDK  v2.0.1.pdf` is the Qore3 API SDK 2017 and SHA-256 `db0ea6442d4103335cd7c92da42c0673a6ae6aea5a2959096946e1222684ce59`. The transport is `/Web/Get` or `/Web/GetXml` with `RequestXml` in the query, or SOAP 1.1 `Process(RequestXml As String)` at `/ecsoap`. `TerminalId` and `Password` are part of the XML. URL-based authentication carries those credentials in a request URL and is unsuitable here.

| Pack ID | Source operation | Catalogue fields and missing inputs |
| --- | --- | --- |
| `IPAY-007` | `FileDownload`, SDK section 7 | `FileType` selects the product file, with optional version fields. The XML response has `StatusCode`, `ProductVer` and `FileData`. The product file defines `ProductVersion`, `ProductCode`, `StoreGUI`, UPCs, denominations and amount limits for the assigned group. Scope out invoice and other file selectors. |
| `IPAY-022` | `PinAvlb` / `pinavlb`, SDK last section | `ProdCode` and decimal `Amount` select a stock enquiry. The source uses two selector spellings and does not establish an authoritative success/stock field shape. |

The documented families include PINs, fixed and variable top-up, POS activation and bill pay. Before implementing an iPay read, obtain an approved current HTTPS SOAP WSDL and sanitized successful and denied responses or an authenticated product-file feed. Confirm case and selectors, assigned countries and catalogues, currency, precision, actual debit and fees, availability, error handling, rate limits and retry behavior. The separate test-credential PDF was identified by filename.

## Central catalogue boundary

Backend provider reads produce scoped discovery. Reviewed mapping supplies approved canonical product and offer identifiers, expiry, currency and exact debit/fee units before a fenced import can create a completed snapshot. The pricing engine works on normalized minor units. Controlled publication creates immutable revisions. Payment-backend and kiosk-machine clients use the scoped NukhbaPay published catalogue API. Current vendor discovery classes have no canonical importer or publication dependency. Operational acceptance still requires provider account evidence and external client scope ownership. [Public API contract](../security/brick4b-published-catalogue-api.md) · [Browser boundary tests](../../scripts/test/browser-boundary.test.mjs)
