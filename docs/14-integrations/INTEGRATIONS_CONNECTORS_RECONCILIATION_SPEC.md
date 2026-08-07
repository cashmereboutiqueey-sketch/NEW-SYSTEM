# Cashmere OS — Integrations, Connectors & Reconciliation Specification

## Purpose
Define the integration layer that connects Cashmere OS to Shopify, payment providers, Meta/marketing platforms, biometric devices and future services without allowing external systems to bypass the internal ledger.

## 1. Integration principle
Cashmere OS remains the internal operational and accounting source of truth. External systems are sources of events/data, not independent books.

Every connector must preserve external IDs, timestamps, raw payload/reference, sync status, retry state and the resulting internal record IDs.

## 2. Connector architecture
`External System → Connector → Raw Event → Validation → Idempotency → Mapping → Internal Transaction → Reconciliation`

Connectors must be isolated from business calculations. A Shopify webhook must never directly calculate accounting balances; it creates a normalized event that domain services process.

## 3. Shopify
Support products, variants, inventory, orders, customers, refunds, fulfilments and cancellations.

Webhook events are preferred for near-real-time updates, with scheduled reconciliation jobs as a safety net.

Store Shopify shop ID, product ID, variant ID, order ID, line ID and event ID mappings.

## 4. Social/moderator
Social DMs do not require a third-party API to be first-class orders. Moderators create orders directly in Cashmere OS.

If future messaging integrations are connected, inbound conversations can create/update leads but must not silently create paid orders without the configured confirmation workflow.

## 5. POS
POS runs against internal product, price, customer and inventory services. Sales create internal transactions immediately and can optionally sync to external fiscal/receipt devices where applicable.

Offline POS operation should use a controlled local queue with unique transaction IDs and later reconciliation.

## 6. Payment integrations
Payment gateway records are mapped to internal payment intents/transactions. Settlement records are separate from customer payment authorization.

Required states may include:
`Pending → Authorized → Captured → Settled`
with failure, refund, partial refund and chargeback paths where supported.

COD remains a distinct payment/settlement flow because collection and failed delivery create different economics.

## 7. Bank reconciliation
Bank statements can be imported through supported APIs/files.

Matching uses amount, date, reference and configured tolerance. Matched items link bank transactions to internal payments. Unmatched items remain visible for review.

Never force a match solely to make the reconciliation screen green.

## 8. Meta Ads and marketing
Import campaign, ad set/ad identifiers, spend, dates and available performance data. Marketing spend enters the Brand marketing ledger through controlled source records.

Attribution is evidence-based; missing attribution remains unknown.

## 9. Biometric/fingerprint
Connector imports raw punches with device/employee mapping. Raw punches are immutable. Corrections happen in attendance workflow with audit trail.

CSV import is supported when a device has no usable API.

## 10. Email/SMS/WhatsApp
Messaging integrations are optional. Customer consent/preferences and delivery status must be stored where legally required.

Outbound campaigns must remain attributable to a CRM campaign when possible.

No messaging connector should modify financial or inventory records directly.

## 11. Webhook safety
Every webhook handler must support:
- signature verification where provider supports it
- idempotency key/event ID
- timestamp validation where appropriate
- retry-safe processing
- dead-letter/error state
- replay capability

A duplicate webhook must produce zero duplicate financial/inventory effects.

## 12. Sync states
Recommended states:
`Received → Validating → Mapped → Processed → Reconciled`

Failures:
`Retrying → Failed → Dead Letter → Resolved/Replayed`

## 13. External mapping
Maintain explicit mappings rather than assuming names/SKUs are stable.

Example:
`Internal SKU CASHMERE-01-M ↔ Shopify Variant 98765`

Mappings have effective dates and audit history where relevant.

## 14. Data ownership
Internal master data:
- SKU identity
- accounting classification
- inventory valuation
- transfer price
- cost snapshots
- customer financial metrics
- production records

External systems may remain authoritative for channel-specific presentation fields where configured, such as Shopify product descriptions/images.

## 15. Reconciliation framework
Every connector gets reconciliation views for:
- record counts
- quantities
- values
- statuses
- missing records
- duplicate candidates
- unmatched records
- timing differences

Reconciliation should compare both directions where possible.

## 16. Shopify reconciliation
Daily compare:
- Shopify order count vs internal imported orders
- line quantities
- order totals
- refunds
- fulfilment status
- inventory quantities
- cancellations

Differences generate exceptions, not silent corrections.

## 17. POS reconciliation
Compare shift opening cash, sales by payment method, refunds, cash movements and closing count.

Cashier closes a shift; unresolved variance remains visible and requires approval/comment.

## 18. Payment reconciliation
Compare gateway transactions, internal payments, settlements, fees, refunds and bank receipts.

Show gross, fee, net settlement and expected settlement date separately.

## 19. Inventory reconciliation
Compare ledger quantity/value to each channel/location observation. Do not overwrite the ledger to match an external number without a controlled stock adjustment.

## 20. Accounting reconciliation
Every operational source event must be traceable to accounting entries and vice versa.

Unposted source events, orphan journal lines and out-of-balance intercompany records are exceptions.

## 21. Retry and failure handling
Transient failures retry with backoff. Permanent validation errors enter a review queue with human-readable reason and source reference.

Reprocessing must be safe and idempotent.

## 22. Observability
Integration dashboard:
- connector status
- last successful sync
- events received
- processed
- failed
- dead-letter count
- retry count
- reconciliation exceptions

Critical connector failures generate alerts.

## 23. Security
Secrets live in environment/secret storage, never database plaintext or source control. Least-privilege credentials are required. Rotate credentials without changing internal identifiers.

## 24. Rate limits
Connectors respect provider rate limits and use pagination, backoff and incremental sync. Full re-sync is an explicit administrative operation, not the default.

## 25. Import history
Every import records source, start/end time, record count, success/failure count, user/system actor and reconciliation result.

## 26. Manual correction
Manual corrections create explicit adjustment records. They cannot mutate the external event payload or erase the original internal transaction.

## 27. Future connector contract
A new connector must define:
1. external entities/events
2. authentication
3. webhook/polling mechanism
4. mapping keys
5. idempotency strategy
6. normalized events
7. failure/retry strategy
8. reconciliation rules
9. security requirements
10. acceptance tests

## 28. Acceptance criteria
Connectors are complete when external events are normalized, duplicate-safe, auditable, retryable and reconcilable; Shopify, POS, payment, ads and biometric flows can fail without corrupting the internal books; and every integration exception has a visible owner and resolution path.
