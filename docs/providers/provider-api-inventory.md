# Provider API inventory

The edition 1.3 provider ZIP lists **119 operation records and 2 webhook definitions**. The operation count includes selectors, biller variants and XML actions sharing a transport route. The paths below are the pack inventory and may include optional path placeholders. The coverage document describes the implemented request forms. [Pack coverage](provider-api-pack-1.3.md)

| Provider | Operation records | Backend sandbox reads | Additional wire adapters | iPay SOAP scope | No adapter | Webhook validators |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SSL Wireless | 16 | 3 | 13 | 0 | 0 | 0 |
| IronGate Digital | 67 | 7 | 55 | 0 | 5 | 2 |
| Finxplor Connect | 14 | 2 | 0 | 0 | 12 | 0 |
| iPay / Qore3 | 22 | 0 | 0 | 13 | 9 | 0 |
| **Total** | **119** | **12** | **68** | **13** | **26** | **2** |

Sandbox reads are backend adapters exercised by local tests. A live sandbox check requires the approved tenant, provider account, HTTPS origin and credentials. [Sandbox runbook](../runbooks/qualification/provider-sandbox.md)

- **Wire adapter** covers the documented request and a validated response projection in mock tests. Product-specific eligibility, durable transaction admission, recovery and fulfilment still require runtime composition.
- **iPay SOAP scope** covers an HTTPS SOAP 1.1 `Process` transport and the recorded inner SDK forms with mock responses. The assigned WSDL supplies the exact binding. Financial operations require durable admission and a PIN purchase requires a protected fulfilment store. [iPay scope and source](provider-api-pack-1.3.md#ipay--qore3)
- **Callback verifier** checks the reference signature and correlates the callback with a trusted attempt. The callback triggers a status recheck only. Public intake, durable deduplication and provider acknowledgement are pending.
- **Transaction workflow** requires an approved quote, inquiry, payment or reconciliation flow. Any funds movement needs idempotency, authorization, durable status and recovery.
- **Customer/account workflow** requires an approved purpose and scope for subscriber details, provider balances, transaction data or activation messages.
- **Contract required** means the usable endpoint or typed authenticated request/response definition is incomplete.
- **Legacy v1** requires confirmation that the account still needs and supports the deprecated contract.
- **Deferred** covers the iPay integration decision and its current secure transport contract.
- **Webhook contract required** means sender authentication, correlation, replay handling and acknowledgement behavior need confirmation.

## Remaining integration inputs

- **SSL-007/008** have DESCO and DPDC wire adapters derived from the service-list parameter definitions. Sandbox qualification needs the assigned biller credentials, the current DPDC selectors and account-number encoding, and confirmed status behavior. The BREB branch-code alias needs confirmation when branch configuration is required.
- **IRONGATE-016** requires the v2 auto-detection request and response schemas. The extracted page mixes v1 and v2 field names. **IRONGATE-020/021** require complete PLN postpaid inquiry and payment responses. Confirm whether postpaid payment expects `tr_id` as a JSON integer or string for the assigned account. **IRONGATE-055/056** require the readable PDAM endpoint and field definitions. The **IRONGATE-067** PDF adapter requires a paid inquiry and private receipt storage. Its JSON variant still needs a response schema. Live receipt qualification requires approved account egress and receipt scope.
- **Finxplor** requires the current readable API v1 export with exact authentication, schemas and written operation scope. **iPay** requires a current HTTPS SOAP WSDL or authenticated product feed and an account-specific contract that settles selectors, responses and monetary rules. [Vendor source gaps](provider-api-pack-1.3.md)

## SSL Wireless

| Pack ID | Operation | Method and path | Backend status |
| --- | --- | --- | --- |
| `SSL-001` | Service List - mobile top-up | `GET /api/service-list` | Sandbox read |
| `SSL-002` | Top-Up Bill Info | `POST /api/bill-info` | Wire adapter |
| `SSL-003` | Top-Up Bill Payment | `POST /api/bill-payment` | Wire adapter |
| `SSL-004` | Top-Up Bill Status | `POST /api/bill-status` | Wire adapter |
| `SSL-005` | Top-Up Package List | `GET /api/vr/package-list` | Sandbox read |
| `SSL-006` | Service List - utilities | `GET /api/service-list` | Sandbox read |
| `SSL-007` | Bill Info - common | `POST /api/bill-info` | Wire adapter |
| `SSL-008` | Bill Payment - common | `POST /api/bill-payment` | Wire adapter |
| `SSL-009` | Bill Status - common | `POST /api/bill-status` | Wire adapter |
| `SSL-010` | Bill Cancel - common | `POST /api/bill-cancel` | Wire adapter |
| `SSL-011` | BPDB Prepaid Bill Info | `POST /api/bill-info` | Wire adapter |
| `SSL-012` | BPDB Prepaid Bill Payment | `POST /api/bill-payment` | Wire adapter |
| `SSL-013` | BPDB Prepaid Bill Status | `POST /api/bill-status` | Wire adapter |
| `SSL-014` | BREB Prepaid Bill Info | `POST /api/bill-info` | Wire adapter |
| `SSL-015` | BREB Prepaid Bill Payment | `POST /api/bill-payment` | Wire adapter |
| `SSL-016` | BREB Prepaid Bill Status | `POST /api/bill-status` | Wire adapter |

## IronGate Digital

| Pack ID | Operation | Method and path | Backend status |
| --- | --- | --- | --- |
| `IRONGATE-001` | Check Balance | `POST /api/check-balance` | Wire adapter |
| `IRONGATE-002` | Price List | `POST /api/pricelist/:type/:operator` | Sandbox read |
| `IRONGATE-003` | Game Code List | `POST /api/gamelist` | Sandbox read |
| `IRONGATE-004` | Check Operator Prefix | `POST /api/check-operator` | Wire adapter |
| `IRONGATE-005` | eSIM Indonesia List | `POST /api/esimlist/:operator` | Sandbox read |
| `IRONGATE-006` | eSIM International List | `POST /api/esiminternationallist/:type` | Sandbox read |
| `IRONGATE-007` | Send Email Activation eSIM | `POST /api/esim/notification/activation` | Wire adapter |
| `IRONGATE-008` | Inquiry PLN | `POST /api/inquiry-pln` | Wire adapter |
| `IRONGATE-009` | Inquiry OVO | `POST /api/inquiry-ovo` | Wire adapter |
| `IRONGATE-010` | Inquiry Game Format | `POST /api/game/format` | Sandbox read |
| `IRONGATE-011` | Inquiry Game Server | `POST /api/inquiry-game-server` | Sandbox read |
| `IRONGATE-012` | Check Game ID | `POST /api/check-game-id` | Wire adapter |
| `IRONGATE-013` | Check Number | `POST /api/check-number` | Wire adapter |
| `IRONGATE-014` | Check Number Packages | `POST /api/check-number-packages` | Wire adapter |
| `IRONGATE-015` | Top Up | `POST /api/top-up` | Wire adapter |
| `IRONGATE-016` | Auto Detect Operator - top-up variant | `POST /api/top-up` | Transaction workflow |
| `IRONGATE-017` | Check Status | `POST /api/check-status` | Wire adapter |
| `IRONGATE-018` | Download Receipt - raw | `GET /api/download/:tr_id/:raw` | Wire adapter |
| `IRONGATE-019` | Postpaid Price List | `POST /api/v1/bill/check/:type` | Sandbox read |
| `IRONGATE-020` | PLN Postpaid Inquiry | `POST /api/v1/bill/check` | Transaction workflow |
| `IRONGATE-021` | PLN Postpaid Payment | `POST /api/v1/bill/check` | Transaction workflow |
| `IRONGATE-022` | Postpaid Check Status | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-023` | Check Balance (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-024` | Price List (legacy v1) | `POST /v1/legacy/index/:type/:operator` | Wire adapter |
| `IRONGATE-025` | Inquiry PLN (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-026` | Inquiry Game Format hp (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-027` | Inquiry Game Server (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-028` | Top Up (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-029` | Auto Detect Operator — top-up variant (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-030` | Check Status (legacy v1) | `POST /v1/legacy/index` | Wire adapter |
| `IRONGATE-031` | BPJS Kesehatan Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-032` | BPJS Kesehatan Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-033` | BPJS Ketenagakerjaan BPU Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-034` | BPJS Ketenagakerjaan BPU Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-035` | BPJS Ketenagakerjaan PU Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-036` | BPJS Ketenagakerjaan PU Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-037` | Member Church Offerings Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-038` | Member Church Offerings Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-039` | Non Member Church Offerings Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-040` | Non Member Church Offerings Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-041` | Custom Denom Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-042` | Custom Denom Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-043` | E-Samsat Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-044` | E-Samsat Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-045` | Insurance Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-046` | Insurance Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-047` | Internet Telkom Speedy / Telkom PSTN Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-048` | Internet Telkom Speedy / Telkom PSTN Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-049` | Internet Non Telkom Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-050` | Internet Non Telkom Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-051` | Multifinance Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-052` | Multifinance Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-053` | PBB Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-054` | PBB Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-055` | PDAM Inquiry | `UNVERIFIED Endpoint unreadable in supplied screenshot` | Contract required |
| `IRONGATE-056` | PDAM Payment | `UNVERIFIED Endpoint unreadable in supplied screenshot` | Contract required |
| `IRONGATE-057` | PGAS Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-058` | PGAS Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-059` | PLN Non Taglist Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-060` | PLN Non Taglist Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-061` | Telco Postpaid Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-062` | Telco Postpaid Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-063` | TV Telkomvision Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-064` | TV Telkomvision Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-065` | TV Non Telkomvision Inquiry | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-066` | TV Non Telkomvision Payment | `POST /api/v1/bill/check` | Wire adapter |
| `IRONGATE-067` | Postpaid Download Receipt | `GET /api/v1/download/:tr_id/:raw/:username` | Wire adapter, PDF form with paid-inquiry binding |
| `IRONGATE-CB-V1` | Prepaid transaction callback v1 | `POST Merchant-configured callback URL` | Callback verifier |
| `IRONGATE-CB-V2` | Prepaid transaction callback v2 | `POST Merchant-configured callback URL` | Callback verifier |

## Finxplor Connect

| Pack ID | Operation | Method and path | Backend status |
| --- | --- | --- | --- |
| `FINXPLOR-001` | Create Transfer | `POST /api/v1/transfers` | Transaction workflow and contract required |
| `FINXPLOR-002` | Get Transfer Quote | `POST /api/v1/transfers/quote` | Contract required |
| `FINXPLOR-003` | Get Transfer Status | `GET /api/v1/transfers/:transactionId` | Contract required |
| `FINXPLOR-004` | List Transfers | `GET /api/v1/transfers` | Contract required |
| `FINXPLOR-005` | Get Payout Routes | `GET /api/v1/transfers/payout-routes` | Contract required |
| `FINXPLOR-006` | Get Product Catalog | `GET /api/v1/products` | Sandbox reads with page-wise validation and full import |
| `FINXPLOR-007` | Get Product Details | `GET /api/v1/products/:productId` | Sandbox read verified for `1002_1643` with a product bound to the latest local scan |
| `FINXPLOR-008` | Purchase Product | `POST /api/v1/purchase` | Transaction workflow and contract required |
| `FINXPLOR-009` | Get Transaction Status | `GET /api/v1/transactions/:id` | Contract required |
| `FINXPLOR-010` | List Transactions | `GET /api/v1/transactions` | Contract required |
| `FINXPLOR-011` | Get Wallet Balance | `GET /api/v1/wallet/balance` | Contract required |
| `FINXPLOR-012` | Get Exchange Rates | `GET /api/v1/exchange-rates` | Contract required |
| `FINXPLOR-013` | Get Supported Currencies | `GET /api/v1/currencies` | Contract required |
| `FINXPLOR-014` | Get API Usage Statistics | `GET /api/v1/usage` | Contract required |

## iPay / Qore3

| Pack ID | Operation | Method and path | Backend status |
| --- | --- | --- | --- |
| `IPAY-001` | PIN Request | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, PIN purchase with protected fulfilment |
| `IPAY-002` | PIN Return / Refund | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, refund by original transaction number |
| `IPAY-003` | PinlessRequest | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, approved account-number products |
| `IPAY-004` | PinlessRequest2ndStep | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, same account-number request with admitted first-step observation |
| `IPAY-005` | eCash Transfer | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, assigned transfer product and admitted confirmation |
| `IPAY-006` | GetBalanceSt | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope |
| `IPAY-007` | File Download (Product, Invoice) | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, product XML only |
| `IPAY-008` | Order - binary PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-009` | Order download - binary PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-010` | Order - comma-separated PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-011` | Order download - comma-separated PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-012` | Order - XML PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-013` | Order download - XML PIN file | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-014` | Physical Sales | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-015` | ChangeStPass | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, reserved terminal password rotation |
| `IPAY-016` | GetLastTrans | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, redacted product and amount summary |
| `IPAY-017` | eCashCollection | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, assigned cash and cheque products with admitted confirmation |
| `IPAY-018` | Query | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, existing PIN/PINless transaction |
| `IPAY-019` | Version | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope |
| `IPAY-020` | SelfRegisterSt | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-021` | Reset Password for B2C | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | Deferred |
| `IPAY-022` | Check Pin availability | `GET / SOAP /Web/Get or /Web/GetXml; SOAP /ecsoap` | iPay SOAP scope, documented positive response |
